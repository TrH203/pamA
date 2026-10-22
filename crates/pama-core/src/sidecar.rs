//! The local server ("sidecar") as seen from the device: where it listens and its token.

use std::fs;

use serde::{Deserialize, Serialize};

use crate::paths;

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
