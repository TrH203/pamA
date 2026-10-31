//! Talking to a pamA server from the device (CLI, desktop), every request through the egress
//! guard: the local server (base URL + per-launch token from `server.json`) or, in remote mode
//! (thin client, spec 004), a remote server with this device's token from the OS keychain.

use serde_json::Value;

use crate::capture::worker::{DigestSink, SinkError};
use crate::net::{GuardedClient, NetError, Policy};
use crate::sidecar::ServerInfo;
use crate::store::Store;

pub const KEY_STRICT_OFFLINE: &str = "strict_offline";
pub const KEY_DECLARED_HOSTS: &str = "declared_hosts";

pub fn policy_from(store: &Store) -> Policy {
    let strict = store.setting(KEY_STRICT_OFFLINE).ok().flatten().as_deref() == Some("true");
    let declared_hosts = store
        .setting(KEY_DECLARED_HOSTS)
        .ok()
        .flatten()
        .map(|s| {
            s.split(',')
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Policy {
        strict,
        declared_hosts,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("the local server is not running (start it with `pama server start`)")]
    NotRunning,
    #[error(transparent)]
    Net(#[from] NetError),
    #[error("server returned {status}: {body}")]
    Status { status: u16, body: String },
    #[error("not logged in to {0} (run `pama login --server {0}`)")]
    NotLoggedIn(String),
}

impl ApiError {
    pub fn retryable(&self) -> bool {
        match self {
            ApiError::NotRunning | ApiError::Net(_) => true,
            // Configuration errors (a rejected key) wait for the user, not for a retry.
            ApiError::Status { status, body } => {
                (*status >= 500 || *status == 429) && !body.contains("\"provider_auth\"")
            }
            ApiError::NotLoggedIn(_) => false,
        }
    }
}

pub struct Api<'s> {
    client: GuardedClient<'s>,
    info: ServerInfo,
    /// Set for a remote server: its normalized base URL.
    remote: Option<String>,
}

/// Kept for the local-only call sites (sidecar health, sync collection).
pub type LocalApi<'s> = Api<'s>;

impl<'s> Api<'s> {
    /// The local server on this machine.
    pub fn connect(store: &'s Store, component: &'static str) -> Result<Self, ApiError> {
        let info = ServerInfo::load().ok_or(ApiError::NotRunning)?;
        Ok(Self {
            client: GuardedClient::new(policy_from(store), store, component),
            info,
            remote: None,
        })
    }

    /// A remote server this device is logged in to.
    pub fn remote(
        store: &'s Store,
        component: &'static str,
        server: &str,
    ) -> Result<Self, ApiError> {
        let url = crate::remote::normalize(server);
        let token = crate::secrets::get(&crate::sync::token_key(&url))
            .ok()
            .flatten()
            .ok_or_else(|| ApiError::NotLoggedIn(url.clone()))?;
        Ok(Self {
            client: GuardedClient::new(policy_from(store), store, component),
            info: ServerInfo {
                url: url.clone(),
                token,
                pid: 0,
            },
            remote: Some(url),
        })
    }

    /// What an owner command talks to: `server` if given, else the remote default server in
    /// remote mode, else the local server.
    pub fn resolve(
        store: &'s Store,
        component: &'static str,
        server: Option<&str>,
    ) -> Result<Self, ApiError> {
        match server.map(str::to_string).or_else(|| {
            (crate::remote::mode(store) == crate::remote::Mode::Remote)
                .then(|| crate::remote::default_server(store))
                .flatten()
        }) {
            Some(url) => Self::remote(store, component, &url),
            None if crate::remote::mode(store) == crate::remote::Mode::Remote => {
                Err(ApiError::NotLoggedIn("a pamA server".into()))
            }
            None => Self::connect(store, component),
        }
    }

    /// The remote server's base URL, or `None` for the local server.
    pub fn remote_url(&self) -> Option<&str> {
        self.remote.as_deref()
    }

    pub fn base_url(&self) -> &str {
        self.info.url.trim_end_matches('/')
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.info.url.trim_end_matches('/'), path)
    }

    fn not_running(&self, e: NetError) -> ApiError {
        match e {
            NetError::Http(ref h) if h.is_connect() && self.remote.is_none() => {
                ApiError::NotRunning
            }
            other => ApiError::Net(other),
        }
    }

    fn handle(resp: reqwest::blocking::Response) -> Result<Value, ApiError> {
        let status = resp.status().as_u16();
        let text = resp.text().map_err(NetError::from)?;
        if !(200..300).contains(&status) {
            return Err(ApiError::Status { status, body: text });
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    pub fn get(&self, path: &str, purpose: &str) -> Result<Value, ApiError> {
        let r = self
            .client
            .get(&self.url(path), purpose, Some(&self.info.token))
            .map_err(|e| self.not_running(e))?;
        Self::handle(r)
    }

    pub fn post(&self, path: &str, purpose: &str, body: &Value) -> Result<Value, ApiError> {
        let r = self
            .client
            .post_json(&self.url(path), purpose, Some(&self.info.token), body)
            .map_err(|e| self.not_running(e))?;
        Self::handle(r)
    }

    /// POST for model-heavy routes: the server may spend up to ~3 minutes drafting and embedding.
    pub fn post_slow(&self, path: &str, purpose: &str, body: &Value) -> Result<Value, ApiError> {
        self.client.check(&self.url(path), purpose)?;
        let r = self
            .client
            .raw()
            .post(self.url(path))
            .bearer_auth(&self.info.token)
            .json(body)
            .timeout(std::time::Duration::from_secs(180))
            .send()
            .map_err(|e| self.not_running(NetError::Http(e)))?;
        Self::handle(r)
    }

    pub fn patch(&self, path: &str, purpose: &str, body: &Value) -> Result<Value, ApiError> {
        self.client.check(&self.url(path), purpose)?;
        let r = self
            .client
            .raw()
            .patch(self.url(path))
            .bearer_auth(&self.info.token)
            .json(body)
            .send()
            .map_err(|e| ApiError::Net(NetError::Http(e)))?;
        Self::handle(r)
    }

    pub fn put(&self, path: &str, purpose: &str, body: &Value) -> Result<Value, ApiError> {
        self.client.check(&self.url(path), purpose)?;
        let r = self
            .client
            .raw()
            .put(self.url(path))
            .bearer_auth(&self.info.token)
            .json(body)
            .send()
            .map_err(|e| ApiError::Net(NetError::Http(e)))?;
        Self::handle(r)
    }

    pub fn healthy(&self) -> bool {
        self.get("/v1/health", "health").is_ok()
    }
}

impl DigestSink for Api<'_> {
    fn submit(&self, body: &Value) -> Result<Value, SinkError> {
        self.post_slow("/v1/transcripts/digest", "capture.digest", body)
            .map_err(|e| {
                if e.retryable() {
                    SinkError::Retryable(e.to_string())
                } else {
                    SinkError::Fatal(e.to_string())
                }
            })
    }
}
