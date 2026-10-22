//! Where bundled assets live: the app's resource dir in a release build, the repository in dev.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

pub struct Resources {
    pub rules: PathBuf,
    pub prompts: PathBuf,
    pub migrations: PathBuf,
    pub web: PathBuf,
    /// Repository root when running from a checkout (development).
    pub repo: Option<PathBuf>,
}

pub fn locate<R: Runtime>(app: &AppHandle<R>) -> Resources {
    if let Ok(dir) = app.path().resource_dir() {
        if dir.join("rules/pama.toml").exists() {
            return Resources {
                rules: dir.join("rules"),
                prompts: dir.join("prompts"),
                migrations: dir.join("migrations"),
                web: dir.join("web"),
                repo: None,
            };
        }
    }
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let repo = repo.canonicalize().unwrap_or(repo);
    Resources {
        rules: repo.join("rules"),
        prompts: repo.join("prompts"),
        migrations: repo.join("apps/server/migrations"),
        web: repo.join("apps/web/dist"),
        repo: Some(repo),
    }
}
