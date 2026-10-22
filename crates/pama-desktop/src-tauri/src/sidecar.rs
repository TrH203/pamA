//! The local server ("sidecar"): reuse one that is already running (e.g. started by the CLI),
//! otherwise start the bundled `pama-server` (or the TypeScript sources in development). The
//! server listens on 127.0.0.1 with a per-launch token; its address is shared via server.json.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use pama_core::client::LocalApi;
use pama_core::paths;
use pama_core::sidecar::{free_port, new_token, server_env, ServerInfo, DEFAULT_PORT};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::resources;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub token: Option<String>,
    pub mode: &'static str,
    pub version: &'static str,
    pub error: Option<String>,
}

fn healthy(state: &AppState) -> Option<ServerInfo> {
    let info = ServerInfo::load()?;
    let store = state.store.lock().ok()?;
    let ok = LocalApi::connect(&store, "desktop").ok()?.healthy();
    ok.then_some(info)
}

fn command<R: Runtime>(app: &AppHandle<R>) -> Result<Command, String> {
    let res = resources::locate(app);
    let mut cmd = if let Ok(dev) = std::env::var("PAMA_SERVER_CMD") {
        let mut c = Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        c.args(if cfg!(windows) {
            ["/C", dev.as_str()]
        } else {
            ["-c", dev.as_str()]
        });
        c
    } else {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let name = if cfg!(windows) {
            "pama-server.exe"
        } else {
            "pama-server"
        };
        let bin = exe.parent().map(|d| d.join(name));
        match (bin, &res.repo) {
            (Some(b), _) if b.exists() => Command::new(b),
            (_, Some(repo)) => {
                let mut c = Command::new("node");
                c.args(["--import", "tsx", "src/index.ts"])
                    .current_dir(repo.join("apps/server"));
                c
            }
            _ => return Err("pama-server is missing from the app bundle".into()),
        }
    };
    cmd.env("PAMA_RULES_DIR", &res.rules)
        .env("PAMA_PROMPTS_DIR", &res.prompts)
        .env("PAMA_MIGRATIONS_DIR", &res.migrations)
        .env("PAMA_WEB_DIR", &res.web);
    Ok(cmd)
}

/// Make sure a server is running; returns its info.
pub fn ensure<R: Runtime>(app: &AppHandle<R>) -> Result<ServerInfo, String> {
    let state = app.state::<AppState>();
    if let Some(info) = healthy(&state) {
        *state.server.lock().unwrap() = Some(info.clone());
        return Ok(info);
    }
    let mut cmd = command(app)?;
    let port = free_port(DEFAULT_PORT);
    let token = new_token();
    std::fs::create_dir_all(paths::server_data_dir()).map_err(|e| e.to_string())?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::pama_home().join("server.log"))
        .map_err(|e| e.to_string())?;
    let env = server_env(&state.store.lock().unwrap());
    cmd.env("PAMA_MODE", "local")
        .env("PAMA_PORT", port.to_string())
        .env("PAMA_BIND", "127.0.0.1")
        .env("PAMA_LOCAL_TOKEN", &token)
        .env("PAMA_DATA_DIR", paths::server_data_dir())
        .envs(env)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start the local server: {e}"))?;
    let info = ServerInfo {
        url: format!("http://127.0.0.1:{port}"),
        token,
        pid: child.id(),
    };
    info.save().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if healthy(&state).is_some() {
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            ServerInfo::remove();
            return Err(format!(
                "the local server exited ({status}); see ~/.pama/server.log"
            ));
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            ServerInfo::remove();
            return Err("the local server did not start in time".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    *state.child.lock().unwrap() = Some(child);
    *state.server.lock().unwrap() = Some(info.clone());
    Ok(info)
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> SidecarStatus {
    let state = app.state::<AppState>();
    let info = state
        .server
        .lock()
        .unwrap()
        .clone()
        .or_else(|| healthy(&state));
    SidecarStatus {
        running: info.is_some(),
        port: info
            .as_ref()
            .and_then(|i| i.url.rsplit(':').next()?.parse().ok()),
        url: info.as_ref().map(|i| i.url.clone()),
        token: info.map(|i| i.token),
        mode: "local",
        version: env!("CARGO_PKG_VERSION"),
        error: None,
    }
}

/// Start in the background and report through `sidecar://state`.
pub fn start_in_background<R: Runtime>(
    app: AppHandle<R>,
    on_ready: impl FnOnce(&AppHandle<R>, &ServerInfo) + Send + 'static,
) {
    std::thread::spawn(move || match ensure(&app) {
        Ok(info) => {
            let _ = app.emit("sidecar://state", serde_json::json!({ "running": true }));
            on_ready(&app, &info);
        }
        Err(e) => {
            let _ = app.emit(
                "sidecar://state",
                serde_json::json!({ "running": false, "error": e }),
            );
        }
    });
}

/// Stop the server if this app started it.
pub fn stop_owned<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let child = state.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        ServerInfo::remove();
    }
}
