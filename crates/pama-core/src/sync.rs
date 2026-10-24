//! Device side of sync (US4, FR-024..026): collect approved digests and tombstones from the local
//! server into the outbox, then deliver them to the target server with idempotency keys
//! (`outbox_id`) and backoff. Delivery is exactly once: the receiver keeps a receipt per id.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Value};

use crate::client::{policy_from, ApiError, LocalApi};
use crate::net::GuardedClient;
use crate::store::{OutboxKind, Store};

#[derive(Debug)]
pub enum DeliverError {
    /// Network, server down, strict offline block: try again later.
    Retryable(String),
    /// The receiver refused it (409 stale, 401 revoked, 422 invalid): give up.
    Rejected(String),
}

pub trait Remote {
    fn deliver(&self, target: &str, kind: OutboxKind, body: &Value) -> Result<(), DeliverError>;

    /// Like [`Remote::deliver`], returning the receiver's JSON reply (drafts record the server's
    /// digest id and review status from it).
    fn deliver_with_reply(
        &self,
        target: &str,
        kind: OutboxKind,
        body: &Value,
    ) -> Result<Value, DeliverError> {
        self.deliver(target, kind, body).map(|()| Value::Null)
    }
}

/// Outbox payloads for thin-client drafts carry this flag; they go to `/v1/sync/drafts` instead
/// of `/v1/sync/digests` (the outbox kind stays `digest_upsert`: older device stores only accept
/// the original kinds).
pub const DRAFT_FLAG: &str = "draft";

pub fn is_draft(body: &Value) -> bool {
    body[DRAFT_FLAG].as_bool() == Some(true)
}

/// Remember what the server made of a delivered draft in the device copy.
fn record_draft_reply(store: &Store, target: &str, body: &Value, reply: &Value) {
    let src = &body["digest"]["source"];
    let (Some(agent), Some(sid)) = (src["agent"].as_str(), src["agent_session_id"].as_str()) else {
        return;
    };
    if let Ok(Some(mut d)) = store.remote_digest(target, agent, sid) {
        if d.status == "deleted" {
            return;
        }
        d.server_digest_id = reply["digest_id"].as_str().map(str::to_string);
        d.version = reply["version"].as_i64();
        if let Some(st) = reply["status"].as_str() {
            d.status = st.to_string();
        }
        let _ = store.put_remote_digest(&d);
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct DeliverReport {
    pub sent: usize,
    pub retrying: usize,
    pub dead: usize,
}

/// Does the target server accept `source.git.branches`? Older servers validate digests strictly
/// and would reject the field, so it is only sent when `/v1/health` advertises `branch_lists`.
pub fn supports_branch_lists(health: &Value) -> bool {
    health["capabilities"]
        .as_array()
        .is_some_and(|c| c.iter().any(|x| x == "branch_lists"))
}

/// Drop what the target cannot read: the branch list stays out for servers without
/// `branch_lists`; `git.branch` and `bundle_key` carry the same information for them.
pub fn prepare_digest_body(body: &mut Value, branch_lists_supported: bool) {
    if branch_lists_supported {
        return;
    }
    if let Some(git) = body
        .pointer_mut("/digest/source/git")
        .and_then(Value::as_object_mut)
    {
        git.remove("branches");
    }
}

/// Key under which the device token for `target` is kept in the OS keychain.
pub fn token_key(target: &str) -> String {
    format!("device-token:{}", target.trim_end_matches('/'))
}

/// Deliver every due outbox item once.
pub fn deliver_due(store: &Store, remote: &impl Remote) -> crate::store::Result<DeliverReport> {
    let mut r = DeliverReport::default();
    for item in store.outbox_due(200)? {
        let mut body = item.payload.clone();
        body["outbox_id"] = json!(item.id);
        match remote.deliver_with_reply(&item.target, item.kind, &body) {
            Ok(reply) => {
                if is_draft(&body) {
                    record_draft_reply(store, &item.target, &body, &reply);
                }
                store.outbox_sent(&item.id)?;
                r.sent += 1;
            }
            Err(DeliverError::Retryable(e)) => {
                store.outbox_failed(&item.id, &e)?;
                r.retrying += 1;
            }
            Err(DeliverError::Rejected(e)) => {
                store.outbox_dead(&item.id, &e)?;
                r.dead += 1;
            }
        }
    }
    Ok(r)
}

/// Move what the local server says is pending into the outbox, then acknowledge it.
pub fn collect(store: &Store, local: &LocalApi) -> Result<usize, ApiError> {
    let p = local.get("/v1/sync/pending", "sync.pending")?;
    let mut acked_digests = Vec::new();
    let mut acked_tombstones = Vec::new();
    for d in p["digests"].as_array().into_iter().flatten() {
        let target = d["target"].as_str().unwrap_or_default();
        let payload = json!({
            "digest": d["digest"],
            "approved_at": d["approved_at"],
            "sync_enabled_at": d["sync_enabled_at"],
            "project_name": d["project_name"],
            "bundle_name": d["bundle_name"],
            "bundle_name_source": d["bundle_name_source"],
        });
        if store
            .outbox_push(OutboxKind::DigestUpsert, target, &payload)
            .is_ok()
        {
            acked_digests.push(json!({ "digest_id": d["digest_id"], "target": target }));
        }
    }
    for t in p["tombstones"].as_array().into_iter().flatten() {
        let payload = json!({ "source_type": t["source_type"], "source_key": t["source_key"] });
        let target = t["target"].as_str().unwrap_or_default();
        if store
            .outbox_push(OutboxKind::SourceTombstone, target, &payload)
            .is_ok()
        {
            acked_tombstones.push(t["id"].clone());
        }
    }
    let n = acked_digests.len() + acked_tombstones.len();
    if n > 0 {
        local.post(
            "/v1/sync/ack",
            "sync.ack",
            &json!({ "digests": acked_digests, "tombstones": acked_tombstones }),
        )?;
    }
    Ok(n)
}

/// HTTPS delivery to a pamA server, through the egress guard, with the paired device token.
pub struct HttpRemote<'s> {
    client: GuardedClient<'s>,
    /// `branch_lists` support per target, learned once from `/v1/health`.
    branch_lists: RefCell<HashMap<String, bool>>,
}

impl<'s> HttpRemote<'s> {
    pub fn new(store: &'s Store) -> Self {
        Self {
            client: GuardedClient::new(policy_from(store), store, "desktop"),
            branch_lists: RefCell::new(HashMap::new()),
        }
    }

    fn supports_branch_lists(&self, target: &str) -> Result<bool, DeliverError> {
        let key = target.trim_end_matches('/').to_string();
        if let Some(known) = self.branch_lists.borrow().get(&key) {
            return Ok(*known);
        }
        let resp = self
            .client
            .get(&format!("{key}/v1/health"), "sync.health", None)
            .map_err(|e| DeliverError::Retryable(e.to_string()))?;
        let health: Value = resp.json().unwrap_or(Value::Null);
        let known = supports_branch_lists(&health);
        self.branch_lists.borrow_mut().insert(key, known);
        Ok(known)
    }
}

impl Remote for HttpRemote<'_> {
    fn deliver(&self, target: &str, kind: OutboxKind, body: &Value) -> Result<(), DeliverError> {
        self.deliver_with_reply(target, kind, body).map(|_| ())
    }

    fn deliver_with_reply(
        &self,
        target: &str,
        kind: OutboxKind,
        body: &Value,
    ) -> Result<Value, DeliverError> {
        let draft = is_draft(body);
        let path = match kind {
            OutboxKind::DigestUpsert if draft => "/v1/sync/drafts",
            OutboxKind::DigestUpsert => "/v1/sync/digests",
            OutboxKind::SourceTombstone => "/v1/sync/tombstones",
            OutboxKind::BundleChange => return Err(DeliverError::Rejected("unsupported".into())),
        };
        let url = format!("{}{path}", target.trim_end_matches('/'));
        let mut prepared;
        let body = if kind == OutboxKind::DigestUpsert {
            prepared = body.clone();
            if let Some(o) = prepared.as_object_mut() {
                o.remove(DRAFT_FLAG);
            }
            // Servers that take drafts all read branch lists.
            if !draft {
                prepare_digest_body(&mut prepared, self.supports_branch_lists(target)?);
            }
            &prepared
        } else {
            body
        };
        let purpose = match kind {
            OutboxKind::DigestUpsert if draft => "sync.draft",
            OutboxKind::DigestUpsert => "sync.digest",
            _ => "sync.tombstone",
        };
        // Check the egress policy first so a blocked host never needs a token.
        if let Err(e) = self.client.check(&url, purpose) {
            return Err(DeliverError::Retryable(e.to_string()));
        }
        let token = crate::secrets::get(&token_key(target))
            .ok()
            .flatten()
            .ok_or_else(|| {
                DeliverError::Retryable(format!("not logged in to {target} (pama login)"))
            })?;
        let resp = match self.client.post_json_prechecked(&url, Some(&token), body) {
            Ok(r) => r,
            Err(e) => return Err(DeliverError::Retryable(e.to_string())),
        };
        let status = resp.status().as_u16();
        match status {
            200..=299 => Ok(resp.json().unwrap_or(Value::Null)),
            429 | 500..=599 => Err(DeliverError::Retryable(format!("server returned {status}"))),
            _ => Err(DeliverError::Rejected(format!(
                "server returned {status}: {}",
                resp.text().unwrap_or_default()
            ))),
        }
    }
}

/// Collect from the local server (if running) and deliver what is due.
pub fn sync_once(store: &Store) -> crate::store::Result<DeliverReport> {
    if let Ok(local) = LocalApi::connect(store, "desktop") {
        let _ = collect(store, &local);
    }
    deliver_due(store, &HttpRemote::new(store))
}
