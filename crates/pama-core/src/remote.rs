//! Remote mode (thin client, spec 004): which servers this device is logged in to, the device
//! login flow (research R1), per-project sync opt-in, and pulling review decisions made on the
//! server back into the device's own copies (the device stays the source of truth, FR-025).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::client::{policy_from, Api, ApiError};
use crate::net::GuardedClient;
use crate::store::{now_ms, RemoteDigest, Store};

pub const KEY_MODE: &str = "mode";
pub const KEY_SERVERS: &str = "remote.servers";
/// Default server (also the default sync target, as before).
pub const KEY_DEFAULT_TARGET: &str = "sync.default_target";
pub const KEY_SYNC_PROJECTS: &str = "remote.sync_projects";
/// Pull review decisions at most this often from ordinary commands.
const PULL_EVERY_MS: i64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Everything on this machine (local server with its own database).
    Local,
    /// Only `pama` on this machine; review, links and inbox on a remote server.
    Remote,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Local => "local",
            Mode::Remote => "remote",
        }
    }
}

pub fn normalize(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

pub fn mode(store: &Store) -> Mode {
    match store.setting(KEY_MODE).ok().flatten().as_deref() {
        Some("remote") => Mode::Remote,
        _ => Mode::Local,
    }
}

pub fn set_mode(store: &Store, m: Mode) -> crate::store::Result<()> {
    store.set_setting(KEY_MODE, m.as_str())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerEntry {
    pub url: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

pub fn servers(store: &Store) -> Vec<ServerEntry> {
    store
        .setting(KEY_SERVERS)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_servers(store: &Store, list: &[ServerEntry]) -> crate::store::Result<()> {
    store.set_setting(KEY_SERVERS, &serde_json::to_string(list).expect("json"))
}

/// Remember a logged-in server and make it the default.
pub fn add_server(store: &Store, entry: ServerEntry) -> crate::store::Result<()> {
    let mut list = servers(store);
    list.retain(|s| s.url != entry.url);
    let url = entry.url.clone();
    list.push(entry);
    save_servers(store, &list)?;
    store.set_setting(KEY_DEFAULT_TARGET, &url)
}

/// Forget a server; the default moves to another logged-in server, if any. Returns what is left.
pub fn remove_server(store: &Store, url: &str) -> crate::store::Result<Vec<ServerEntry>> {
    let mut list = servers(store);
    list.retain(|s| s.url != url);
    save_servers(store, &list)?;
    if store.setting(KEY_DEFAULT_TARGET)?.as_deref() == Some(url) {
        match list.last() {
            Some(s) => store.set_setting(KEY_DEFAULT_TARGET, &s.url)?,
            None => store.delete_setting(KEY_DEFAULT_TARGET)?,
        }
    }
    Ok(list)
}

pub fn default_server(store: &Store) -> Option<String> {
    store
        .setting(KEY_DEFAULT_TARGET)
        .ok()
        .flatten()
        .map(|s| normalize(&s))
}

pub fn server_entry(store: &Store, url: &str) -> Option<ServerEntry> {
    servers(store).into_iter().find(|s| s.url == url)
}

// --- per-project sync opt-in (remote mode) --------------------------------------------------

pub fn sync_projects(store: &Store) -> Vec<String> {
    store
        .setting(KEY_SYNC_PROJECTS)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn sync_enabled(store: &Store, project_key: &str) -> bool {
    sync_projects(store).iter().any(|p| p == project_key)
}

/// When sync was turned on for `project_key` (RFC 3339), sent with every draft so the server
/// can refuse deliveries older than a later tombstone.
pub fn sync_enabled_at(store: &Store, project_key: &str) -> Option<String> {
    store
        .setting(&format!("remote.sync_enabled_at:{project_key}"))
        .ok()
        .flatten()
}

/// The project keys a directory can be seen under. Agents report the shell's logical working
/// directory (e.g. `/var/…` on macOS) while tools see the real path (`/private/var/…`); outside
/// a git repository the key is a hash of the path, so both spellings are covered. Inside a repo
/// both resolve to the same remote-based key.
pub fn project_keys(logical: &str) -> Vec<crate::project::ProjectInfo> {
    let mut out = vec![crate::project::resolve(Some(logical), None)];
    if let Ok(real) = std::fs::canonicalize(logical) {
        let p = crate::project::resolve(Some(&real.to_string_lossy()), None);
        if out.iter().all(|x| x.key != p.key) {
            out.push(p);
        }
    }
    out
}

/// Turn sync on or off for a project. Returns whether anything changed.
pub fn set_project_sync(store: &Store, project_key: &str, on: bool) -> crate::store::Result<bool> {
    let mut list = sync_projects(store);
    let had = list.iter().any(|p| p == project_key);
    if on == had {
        return Ok(false);
    }
    if on {
        list.push(project_key.to_string());
        store.set_setting(
            &format!("remote.sync_enabled_at:{project_key}"),
            &crate::capture::worker::rfc3339(std::time::SystemTime::now()),
        )?;
    } else {
        list.retain(|p| p != project_key);
    }
    store.set_setting(
        KEY_SYNC_PROJECTS,
        &serde_json::to_string(&list).expect("json"),
    )?;
    Ok(true)
}

// --- device login ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoginStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoginDone {
    pub token: String,
    pub device_id: String,
    pub workspace_id: String,
}

#[derive(Debug, thiserror::Error)]
pub enum LoginError {
    #[error("this server does not support `pama login` (too old or local); use `pama pair`")]
    Unsupported,
    #[error("the login was denied in the browser")]
    Denied,
    #[error("the login request expired; run `pama login` again")]
    Expired,
    #[error("{0}")]
    Net(String),
    #[error("server returned {0}")]
    Status(String),
}

pub struct Login<'s> {
    client: GuardedClient<'s>,
    server: String,
}

impl<'s> Login<'s> {
    pub fn new(store: &'s Store, server: &str) -> Self {
        Self {
            client: GuardedClient::new(policy_from(store), store, "cli"),
            server: normalize(server),
        }
    }

    pub fn start(&self, device_name: &str) -> Result<LoginStart, LoginError> {
        let resp = self
            .client
            .post_json(
                &format!("{}/v1/auth/device/start", self.server),
                "login.start",
                None,
                &json!({ "device_name": device_name }),
            )
            .map_err(|e| LoginError::Net(e.to_string()))?;
        match resp.status().as_u16() {
            200 => resp.json().map_err(|e| LoginError::Net(e.to_string())),
            404 => Err(LoginError::Unsupported),
            s => Err(LoginError::Status(format!(
                "{s}: {}",
                resp.text().unwrap_or_default()
            ))),
        }
    }

    /// One poll: `Ok(None)` while the owner has not decided yet.
    pub fn poll(&self, device_code: &str) -> Result<Option<LoginDone>, LoginError> {
        let resp = self
            .client
            .post_json(
                &format!("{}/v1/auth/device/token", self.server),
                "login.poll",
                None,
                &json!({ "device_code": device_code }),
            )
            .map_err(|e| LoginError::Net(e.to_string()))?;
        match resp.status().as_u16() {
            200 => resp
                .json()
                .map(Some)
                .map_err(|e| LoginError::Net(e.to_string())),
            428 => Ok(None),
            403 => Err(LoginError::Denied),
            410 => Err(LoginError::Expired),
            s => Err(LoginError::Status(format!(
                "{s}: {}",
                resp.text().unwrap_or_default()
            ))),
        }
    }

    /// Poll until approved, denied or expired (`sleep` is injectable for tests).
    pub fn wait(
        &self,
        start: &LoginStart,
        sleep: impl Fn(Duration),
    ) -> Result<LoginDone, LoginError> {
        let deadline = now_ms() + start.expires_in as i64 * 1_000;
        let mut transient = 0;
        loop {
            match self.poll(&start.device_code) {
                Ok(Some(done)) => return Ok(done),
                Ok(None) => transient = 0,
                // A flaky network should not end a login the owner is about to approve.
                Err(LoginError::Net(e)) => {
                    transient += 1;
                    if transient > 5 {
                        return Err(LoginError::Net(e));
                    }
                }
                Err(e) => return Err(e),
            }
            if now_ms() > deadline {
                return Err(LoginError::Expired);
            }
            sleep(Duration::from_secs(start.interval.max(1)));
        }
    }
}

/// Store the device token in the keychain and remember the server (mode becomes remote).
pub fn finish_login(store: &Store, server: &str, done: &LoginDone) -> anyhow_like::Result<()> {
    let url = normalize(server);
    crate::secrets::set(&crate::sync::token_key(&url), &done.token)?;
    add_server(
        store,
        ServerEntry {
            url,
            workspace_id: Some(done.workspace_id.clone()),
            device_id: Some(done.device_id.clone()),
        },
    )?;
    set_mode(store, Mode::Remote)?;
    Ok(())
}

/// Small error union so this module does not need `anyhow`.
pub mod anyhow_like {
    #[derive(Debug, thiserror::Error)]
    pub enum Error {
        #[error(transparent)]
        Store(#[from] crate::store::StoreError),
        #[error(transparent)]
        Secret(#[from] crate::secrets::SecretError),
    }
    pub type Result<T> = std::result::Result<T, Error>;
}

// --- on-device drafting sink -----------------------------------------------------------------

/// Remote mode's [`DigestSink`]: draft the digest on this machine, keep the device copy and queue
/// the draft for the server. Only the drafted digest is queued; the transcript events in `body`
/// never leave the machine except to the configured drafting model.
pub struct RemoteSink<'a> {
    pub store: &'a Store,
    pub rules: &'a crate::redact::RuleSet,
    pub model: &'a dyn crate::draft::llm::DraftModel,
    pub target: String,
}

impl crate::capture::worker::DigestSink for RemoteSink<'_> {
    fn submit(&self, body: &Value) -> Result<Value, crate::capture::worker::SinkError> {
        use crate::capture::worker::SinkError;
        use crate::draft::DraftError;
        let project_key = body["project_key"].as_str().unwrap_or_default();
        if !sync_enabled(self.store, project_key) {
            return Err(SinkError::Skipped(format!(
                "sync is off for {project_key}; enable it with `pama sync enable --project {project_key}`"
            )));
        }
        let now = crate::capture::worker::rfc3339(std::time::SystemTime::now());
        let digest =
            crate::draft::draft(body, self.model, self.rules, &now).map_err(|e| match e {
                DraftError::Retryable(m) => SinkError::Retryable(m),
                DraftError::Fatal(m) => SinkError::Fatal(m),
            })?;
        let agent = digest["source"]["agent"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let sid = digest["source"]["agent_session_id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let store_err = |e: crate::store::StoreError| SinkError::Retryable(e.to_string());
        self.store
            .put_remote_digest(&RemoteDigest {
                target: self.target.clone(),
                agent,
                agent_session_id: sid,
                project_key: project_key.to_string(),
                digest: digest.clone(),
                status: "draft".into(),
                server_digest_id: None,
                version: None,
                updated_at: now_ms(),
            })
            .map_err(store_err)?;
        let mut payload = json!({
            crate::sync::DRAFT_FLAG: true,
            "digest": digest,
            "sync_enabled_at": sync_enabled_at(self.store, project_key).unwrap_or_else(|| now.clone()),
        });
        if let Some(n) = body["project_name"].as_str() {
            payload["project_name"] = json!(n);
        }
        let id = self
            .store
            .outbox_push(
                crate::store::OutboxKind::DigestUpsert,
                &self.target,
                &payload,
            )
            .map_err(store_err)?;
        Ok(json!({ "digest_id": id, "status": "queued" }))
    }
}

// --- review pull-back (FR-025) --------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct PullReport {
    pub applied: usize,
    pub skipped: usize,
}

fn cursor_key(url: &str) -> String {
    format!("remote.changes_cursor:{url}")
}

fn pulled_at_key(url: &str) -> String {
    format!("remote.changes_at:{url}")
}

/// Apply one change from the server to the device copy. Device deletions always win.
pub fn apply_change(store: &Store, target: &str, c: &Value) -> crate::store::Result<bool> {
    let agent = c["agent"].as_str().unwrap_or_default();
    let sid = c["agent_session_id"].as_str().unwrap_or_default();
    let status = match c["status"].as_str().unwrap_or_default() {
        s @ ("draft" | "approved" | "discarded") => s,
        // A withdrawn approval is no longer shared; the device keeps it as discarded.
        "withdrawn" => "discarded",
        // Superseded versions are replaced by a newer change for the same session.
        _ => return Ok(false),
    };
    let existing = store.remote_digest(target, agent, sid)?;
    if existing.as_ref().is_some_and(|e| e.status == "deleted") {
        return Ok(false);
    }
    let digest = match (&c["digest"], &existing) {
        (d, _) if !d.is_null() => d.clone(),
        (_, Some(e)) => e.digest.clone(),
        (_, None) => Value::Null,
    };
    if digest.is_null() {
        return Ok(false);
    }
    store.put_remote_digest(&RemoteDigest {
        target: target.to_string(),
        agent: agent.to_string(),
        agent_session_id: sid.to_string(),
        project_key: c["project_key"]
            .as_str()
            .map(str::to_string)
            .or_else(|| existing.as_ref().map(|e| e.project_key.clone()))
            .unwrap_or_default(),
        digest,
        status: status.to_string(),
        server_digest_id: c["digest_id"].as_str().map(str::to_string),
        version: c["version"].as_i64(),
        updated_at: now_ms(),
    })?;
    Ok(true)
}

/// Pull review decisions from a remote server into the device's copies. With `force` false,
/// does nothing if it already ran in the last minute.
pub fn pull_changes(store: &Store, api: &Api<'_>, force: bool) -> Result<PullReport, ApiError> {
    let Some(target) = api.remote_url().map(str::to_string) else {
        return Ok(PullReport::default());
    };
    let last: i64 = store
        .setting(&pulled_at_key(&target))
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if !force && now_ms() - last < PULL_EVERY_MS {
        return Ok(PullReport::default());
    }
    let mut report = PullReport::default();
    // Bounded: 20 pages of 200 changes per run.
    for _ in 0..20 {
        let cursor = store.setting(&cursor_key(&target)).ok().flatten();
        let path = match &cursor {
            Some(c) => format!("/v1/sync/changes?since={c}"),
            None => "/v1/sync/changes".into(),
        };
        let page = api.get(&path, "sync.changes")?;
        let changes = page["changes"].as_array().cloned().unwrap_or_default();
        for c in &changes {
            if apply_change(store, &target, c).map_err(|e| ApiError::Status {
                status: 0,
                body: e.to_string(),
            })? {
                report.applied += 1;
            } else {
                report.skipped += 1;
            }
        }
        if let Some(next) = page["cursor"].as_str() {
            let _ = store.set_setting(&cursor_key(&target), next);
        }
        if changes.len() < 200 {
            break;
        }
    }
    let _ = store.set_setting(&pulled_at_key(&target), &now_ms().to_string());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn servers_and_mode() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(mode(&s), Mode::Local);
        assert_eq!(default_server(&s), None);
        add_server(
            &s,
            ServerEntry {
                url: "https://a.example".into(),
                workspace_id: Some("w1".into()),
                device_id: None,
            },
        )
        .unwrap();
        add_server(
            &s,
            ServerEntry {
                url: "https://b.example".into(),
                workspace_id: None,
                device_id: None,
            },
        )
        .unwrap();
        assert_eq!(default_server(&s).as_deref(), Some("https://b.example"));
        let left = remove_server(&s, "https://b.example").unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(default_server(&s).as_deref(), Some("https://a.example"));
        remove_server(&s, "https://a.example").unwrap();
        assert_eq!(default_server(&s), None);
        set_mode(&s, Mode::Remote).unwrap();
        assert_eq!(mode(&s), Mode::Remote);
        assert_eq!(normalize(" https://x.example/ "), "https://x.example");
    }

    #[test]
    fn project_sync_is_opt_in() {
        let s = Store::open_in_memory().unwrap();
        assert!(!sync_enabled(&s, "github.com/acme/shop"));
        assert!(set_project_sync(&s, "github.com/acme/shop", true).unwrap());
        assert!(!set_project_sync(&s, "github.com/acme/shop", true).unwrap());
        assert!(sync_enabled(&s, "github.com/acme/shop"));
        assert!(sync_enabled_at(&s, "github.com/acme/shop").is_some());
        assert!(set_project_sync(&s, "github.com/acme/shop", false).unwrap());
        assert!(!sync_enabled(&s, "github.com/acme/shop"));
    }

    #[test]
    fn changes_update_copies_but_never_resurrect_deletions() {
        let s = Store::open_in_memory().unwrap();
        let t = "https://a.example";
        let base = RemoteDigest {
            target: t.into(),
            agent: "claude_code".into(),
            agent_session_id: "s1".into(),
            project_key: "k".into(),
            digest: json!({ "goal": "draft goal" }),
            status: "draft".into(),
            server_digest_id: None,
            version: None,
            updated_at: 0,
        };
        s.put_remote_digest(&base).unwrap();
        let approved = json!({
            "agent": "claude_code", "agent_session_id": "s1", "project_key": "k",
            "digest_id": "d2", "version": 2, "status": "approved",
            "digest": { "goal": "edited goal" },
        });
        assert!(apply_change(&s, t, &approved).unwrap());
        let got = s.remote_digest(t, "claude_code", "s1").unwrap().unwrap();
        assert_eq!(got.status, "approved");
        assert_eq!(got.digest["goal"], "edited goal");
        assert_eq!(got.version, Some(2));

        let superseded =
            json!({ "agent": "claude_code", "agent_session_id": "s1", "status": "superseded" });
        assert!(!apply_change(&s, t, &superseded).unwrap());

        assert_eq!(s.mark_remote_project_deleted(t, "k").unwrap(), 1);
        assert!(!apply_change(&s, t, &approved).unwrap());
        assert_eq!(
            s.remote_digest(t, "claude_code", "s1")
                .unwrap()
                .unwrap()
                .status,
            "deleted"
        );
    }
}
