//! Talking to the local server from the device (CLI, desktop): base URL + per-launch token from
//! `server.json`, every request through the egress guard.

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
}

impl ApiError {
    pub fn retryable(&self) -> bool {
        match self {
            ApiError::NotRunning | ApiError::Net(_) => true,
            ApiError::Status { status, .. } => *status >= 500 || *status == 429,
        }
    }
}

pub struct LocalApi<'s> {
    client: GuardedClient<'s>,
    info: ServerInfo,
}

impl<'s> LocalApi<'s> {
    pub fn connect(store: &'s Store, component: &'static str) -> Result<Self, ApiError> {
        let info = ServerInfo::load().ok_or(ApiError::NotRunning)?;
        Ok(Self {
            client: GuardedClient::new(policy_from(store), store, component),
            info,
        })
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.info.url.trim_end_matches('/'), path)
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
            .map_err(|e| match e {
                NetError::Http(ref h) if h.is_connect() => ApiError::NotRunning,
                other => ApiError::Net(other),
            })?;
        Self::handle(r)
    }

    pub fn post(&self, path: &str, purpose: &str, body: &Value) -> Result<Value, ApiError> {
        let r = self
            .client
            .post_json(&self.url(path), purpose, Some(&self.info.token), body)
            .map_err(|e| match e {
                NetError::Http(ref h) if h.is_connect() => ApiError::NotRunning,
                other => ApiError::Net(other),
            })?;
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

impl DigestSink for LocalApi<'_> {
    fn submit(&self, body: &Value) -> Result<Value, SinkError> {
        self.post("/v1/transcripts/digest", "capture.digest", body)
            .map_err(|e| {
                if e.retryable() {
                    SinkError::Retryable(e.to_string())
                } else {
                    SinkError::Fatal(e.to_string())
                }
            })
    }
}
