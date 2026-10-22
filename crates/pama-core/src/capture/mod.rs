//! Capture: ended agent sessions → Layer-1-redacted events → draft digest on the local server.

pub mod scan;
pub mod worker;

pub use scan::{scan, ScanReport};
pub use worker::{drain, CaptureOutcome, Worker};

use crate::store::Store;

/// Settings keys controlling which projects are captured (`pama init`).
pub const KEY_CAPTURE_ALL: &str = "capture.all";
pub const KEY_CAPTURE_PROJECTS: &str = "capture.projects";

/// Is capture enabled for a session that ran in `cwd`?
pub fn enabled_for(store: &Store, cwd: Option<&str>) -> bool {
    if store.setting(KEY_CAPTURE_ALL).ok().flatten().as_deref() == Some("true") {
        return true;
    }
    let Some(cwd) = cwd else { return false };
    // Compare real paths too (macOS: /var → /private/var, symlinked home directories).
    let real = std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| cwd.to_string());
    let list: Vec<String> = store
        .setting(KEY_CAPTURE_PROJECTS)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.iter().any(|p| {
        let p = p.trim_end_matches(['/', '\\']);
        [cwd, real.as_str()]
            .iter()
            .any(|c| *c == p || c.starts_with(&format!("{p}/")) || c.starts_with(&format!("{p}\\")))
    })
}

pub fn enable_project(store: &Store, path: &str) -> crate::store::Result<bool> {
    let mut list: Vec<String> = store
        .setting(KEY_CAPTURE_PROJECTS)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if list.iter().any(|p| p == path) {
        return Ok(false);
    }
    list.push(path.to_string());
    store.set_setting(
        KEY_CAPTURE_PROJECTS,
        &serde_json::to_string(&list).expect("json"),
    )?;
    Ok(true)
}
