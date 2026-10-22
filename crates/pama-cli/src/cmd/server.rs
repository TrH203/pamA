//! `pama server start|stop|status`: run the local server when the desktop app is not running.
//! The server binds to 127.0.0.1 unless `--lan` (research R12) and gets a per-launch token.

use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use pama_core::client::{LocalApi, KEY_DECLARED_HOSTS, KEY_STRICT_OFFLINE};
use pama_core::paths;
use pama_core::sidecar::ServerInfo;
use pama_core::store::Store;
use serde_json::json;

use super::Ctx;
use crate::{Exit, ServerAction};

const DEFAULT_PORT: u16 = 7465;

/// Provider settings passed to the server as environment variables.
const PROVIDER_ENV: [(&str, &str); 8] = [
    ("provider.chat.provider", "PAMA_CHAT_PROVIDER"),
    ("provider.chat.model", "PAMA_CHAT_MODEL"),
    ("provider.chat.base_url", "PAMA_CHAT_BASE_URL"),
    ("provider.small.model", "PAMA_SMALL_MODEL"),
    ("provider.embed.provider", "PAMA_EMBED_PROVIDER"),
    ("provider.embed.model", "PAMA_EMBED_MODEL"),
    ("provider.embed.base_url", "PAMA_EMBED_BASE_URL"),
    ("hotkey.answer_source", "PAMA_ANSWER_SOURCE"),
];

/// How to launch the server: `$PAMA_SERVER_CMD` (shell command, for development), or the
/// `pama-server` binary installed next to `pama`.
fn server_command() -> Option<Command> {
    if let Ok(cmd) = std::env::var("PAMA_SERVER_CMD") {
        let mut c = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", &cmd]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", &cmd]);
            c
        };
        c.env_remove("PAMA_SERVER_CMD");
        return Some(c);
    }
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "pama-server.exe"
    } else {
        "pama-server"
    };
    let bin = exe.parent()?.join(name);
    bin.exists().then(|| Command::new(bin))
}

fn free_port(preferred: u16) -> u16 {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(preferred)
}

fn token() -> String {
    format!("{}{}", ulid::Ulid::generate(), ulid::Ulid::generate()).to_lowercase()
}

pub fn running(store: &Store) -> Option<ServerInfo> {
    let info = ServerInfo::load()?;
    let api = LocalApi::connect(store, "cli").ok()?;
    api.healthy().then_some(info)
}

/// Start the server if it is not running. Returns its info.
pub fn ensure_started(store: &Store, lan: bool) -> anyhow::Result<ServerInfo> {
    if let Some(info) = running(store) {
        return Ok(info);
    }
    let mut cmd = server_command().ok_or_else(|| {
        anyhow::anyhow!("pama-server not found next to pama (set PAMA_SERVER_CMD for development)")
    })?;
    let port = free_port(DEFAULT_PORT);
    let token = token();
    let bind = if lan { "0.0.0.0" } else { "127.0.0.1" };
    std::fs::create_dir_all(paths::server_data_dir())?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::pama_home().join("server.log"))?;
    cmd.env("PAMA_MODE", "local")
        .env("PAMA_PORT", port.to_string())
        .env("PAMA_BIND", bind)
        .env("PAMA_LOCAL_TOKEN", &token)
        .env("PAMA_DATA_DIR", paths::server_data_dir())
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    for (key, var) in PROVIDER_ENV {
        if let Some(v) = store.setting(key)? {
            cmd.env(var, v);
        }
    }
    for (provider, var) in [
        ("chat", "PAMA_CHAT_API_KEY"),
        ("embed", "PAMA_EMBED_API_KEY"),
    ] {
        if let Some(p) = store.setting(&format!("provider.{provider}.provider"))? {
            if let Ok(Some(k)) = pama_core::secrets::get(&format!("provider.{p}.key")) {
                cmd.env(var, k);
            }
        }
    }
    if store.setting(KEY_STRICT_OFFLINE)?.as_deref() == Some("true") {
        cmd.env("PAMA_STRICT_OFFLINE", "true");
    }
    if let Some(h) = store.setting(KEY_DECLARED_HOSTS)? {
        cmd.env("PAMA_DECLARED_HOSTS", h);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;
    let info = ServerInfo {
        url: format!("http://127.0.0.1:{port}"),
        token,
        pid: child.id(),
    };
    info.save()?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if running(store).is_some() {
            return Ok(info);
        }
        if let Ok(Some(status)) = child.try_wait() {
            ServerInfo::remove();
            anyhow::bail!(
                "server exited ({status}); see {}",
                paths::pama_home().join("server.log").display()
            );
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    anyhow::bail!(
        "server did not become healthy; see {}",
        paths::pama_home().join("server.log").display()
    )
}

fn stop() -> bool {
    let Some(info) = ServerInfo::load() else {
        return false;
    };
    let ok = if cfg!(windows) {
        Command::new("taskkill")
            .args(["/PID", &info.pid.to_string(), "/T", "/F"])
            .status()
    } else {
        Command::new("kill").arg(info.pid.to_string()).status()
    }
    .map(|s| s.success())
    .unwrap_or(false);
    ServerInfo::remove();
    ok
}

pub fn run(ctx: &Ctx, action: ServerAction) -> anyhow::Result<Exit> {
    match action {
        ServerAction::Start { lan } => {
            let info = ensure_started(&ctx.store, lan)?;
            ctx.print(&json!({ "url": info.url, "pid": info.pid }), || {
                format!("server running at {} (pid {})", info.url, info.pid)
            });
        }
        ServerAction::Stop => {
            let stopped = stop();
            ctx.print(&json!({ "stopped": stopped }), || {
                if stopped {
                    "server stopped".into()
                } else {
                    "server was not running".into()
                }
            });
        }
        ServerAction::Status => match running(&ctx.store) {
            Some(info) => ctx.print(
                &json!({ "running": true, "url": info.url, "pid": info.pid }),
                || format!("running at {} (pid {})", info.url, info.pid),
            ),
            None => {
                ctx.print(&json!({ "running": false }), || "not running".into());
                return Ok(Exit::Network);
            }
        },
    }
    Ok(Exit::Ok)
}
