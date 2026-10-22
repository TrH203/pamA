//! The local server ("sidecar") as seen from the device: where it listens and its token.

use std::fs;

use serde::{Deserialize, Serialize};

use crate::client::{KEY_DECLARED_HOSTS, KEY_STRICT_OFFLINE};
use crate::paths;
use crate::store::Store;

pub const DEFAULT_PORT: u16 = 7465;

/// Device settings passed to the local server as environment variables.
const SETTING_ENV: [(&str, &str); 8] = [
    ("provider.chat.provider", "PAMA_CHAT_PROVIDER"),
    ("provider.chat.model", "PAMA_CHAT_MODEL"),
    ("provider.chat.base_url", "PAMA_CHAT_BASE_URL"),
    ("provider.small.model", "PAMA_SMALL_MODEL"),
    ("provider.embed.provider", "PAMA_EMBED_PROVIDER"),
    ("provider.embed.model", "PAMA_EMBED_MODEL"),
    ("provider.embed.base_url", "PAMA_EMBED_BASE_URL"),
    ("hotkey.answer_source", "PAMA_ANSWER_SOURCE"),
];

/// Environment for a local server started by the CLI or the desktop app: model providers (API
/// keys from the OS keychain), strict offline mode and declared hosts.
pub fn server_env(store: &Store) -> Vec<(String, String)> {
    let mut env = Vec::new();
    for (key, var) in SETTING_ENV {
        if let Ok(Some(v)) = store.setting(key) {
            env.push((var.to_string(), v));
        }
    }
    for (role, var) in [
        ("chat", "PAMA_CHAT_API_KEY"),
        ("embed", "PAMA_EMBED_API_KEY"),
    ] {
        if let Ok(Some(p)) = store.setting(&format!("provider.{role}.provider")) {
            if let Ok(Some(k)) = crate::secrets::get(&format!("provider.{p}.key")) {
                env.push((var.to_string(), k));
            }
        }
    }
    if store.setting(KEY_STRICT_OFFLINE).ok().flatten().as_deref() == Some("true") {
        env.push(("PAMA_STRICT_OFFLINE".into(), "true".into()));
    }
    if let Ok(Some(h)) = store.setting(KEY_DECLARED_HOSTS) {
        env.push(("PAMA_DECLARED_HOSTS".into(), h));
    }
    env
}

/// Per-launch bearer token for the local server (two ULIDs: 160 random bits).
pub fn new_token() -> String {
    format!("{}{}", ulid::Ulid::generate(), ulid::Ulid::generate()).to_lowercase()
}

pub fn free_port(preferred: u16) -> u16 {
    use std::net::TcpListener;
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(preferred)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerInfo {
    pub url: String,
    pub token: String,
    pub pid: u32,
}

impl ServerInfo {
    pub fn load() -> Option<Self> {
        let raw = fs::read_to_string(paths::server_info()).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let p = paths::server_info();
        if let Some(d) = p.parent() {
            fs::create_dir_all(d)?;
        }
        fs::write(&p, serde_json::to_vec_pretty(self).expect("json"))?;
        restrict(&p);
        Ok(())
    }

    pub fn remove() {
        let _ = fs::remove_file(paths::server_info());
    }
}

/// The file holds a bearer token: owner-only permissions.
fn restrict(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}
