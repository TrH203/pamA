//! `pama server start|stop|status`: run the local server when the desktop app is not running.
//! The server binds to 127.0.0.1 unless `--lan` (research R12) and gets a per-launch token.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use fs4::fs_std::FileExt;
use pama_core::client::LocalApi;
use pama_core::paths;
use pama_core::sidecar::{free_port, new_token, server_env, ServerInfo, DEFAULT_PORT};
use pama_core::store::Store;
use serde_json::json;

use super::Ctx;
use crate::ui::{self, Mark};
use crate::{Exit, ServerAction};

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

pub fn running(store: &Store) -> Option<ServerInfo> {
    let info = ServerInfo::load()?;
    let api = LocalApi::connect(store, "cli").ok()?;
    api.healthy().then_some(info)
}

/// Run `start` under an exclusive lock on `lock_path`, unless `check` finds the work already
/// done, before or after the lock is taken. Two processes that both see "not running" thus
/// start one server: the second waits for the first, then finds it healthy.
fn start_once<T>(
    lock_path: &Path,
    check: impl Fn() -> Option<T>,
    start: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    if let Some(t) = check() {
        return Ok(t);
    }
    if let Some(dir) = lock_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path)?;
    // Released when `file` is dropped (also when this process dies).
    FileExt::lock_exclusive(&file)?;
    if let Some(t) = check() {
        return Ok(t);
    }
    let out = start();
    drop(file);
    out
}

/// Start the server if it is not running. Returns its info. Concurrent CLI callers (commands,
/// drains started by hooks) serialise on `PAMA_HOME/server.lock`, so only one server starts
/// and `server.json` keeps the token of the server that runs.
pub fn ensure_started(store: &Store, lan: bool) -> anyhow::Result<ServerInfo> {
    start_once(
        &paths::pama_home().join("server.lock"),
        || running(store),
        || spawn_server(store, lan),
    )
}

fn spawn_server(store: &Store, lan: bool) -> anyhow::Result<ServerInfo> {
    let mut cmd = server_command().ok_or_else(|| {
        anyhow::anyhow!("pama-server not found next to pama (set PAMA_SERVER_CMD for development)")
    })?;
    // PAMA_PORT picks the preferred port (e.g. several isolated setups on one machine).
    let preferred = std::env::var("PAMA_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let port = free_port(preferred);
    let token = new_token();
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
    cmd.envs(server_env(store));
    // The console's Doctor page runs `pama doctor --report` through this binary.
    if let Ok(exe) = std::env::current_exe() {
        cmd.env("PAMA_BIN", exe);
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

pub fn open_url(url: &str) {
    let _ = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else if cfg!(windows) {
        Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
}

/// `pama console`: the link carries this launch's token in the fragment (never sent to the
/// server); the console trades it for a cookie, so later tabs need nothing.
pub fn console(ctx: &Ctx, print: bool) -> anyhow::Result<Exit> {
    // Remote mode (spec 004): a one-time sign-in link to the remote console.
    if ctx.server.is_some()
        || pama_core::remote::mode(&ctx.store) == pama_core::remote::Mode::Remote
    {
        let api = match ctx.api() {
            Ok(a) => a,
            Err(e) => return Ok(super::api_exit(&e)),
        };
        let link = match api.post("/v1/auth/device/console-link", "console", &json!({})) {
            Ok(v) => v["url"].as_str().unwrap_or_default().to_string(),
            Err(e) => {
                // No owner email (self-host with an owner token only): plain console URL.
                if !matches!(e, pama_core::client::ApiError::Status { status: 409, .. }) {
                    return Ok(super::api_exit(&e));
                }
                format!("{}/", api.base_url())
            }
        };
        if print {
            ctx.print(&json!({ "url": link }), || link.clone());
        } else {
            open_url(&link);
            ctx.print(&json!({ "url": api.base_url() }), || {
                format!("opened {} in your browser", api.base_url())
            });
        }
        return Ok(Exit::Ok);
    }
    let spin = ui::spinner(ctx.json, "starting the local server…");
    let info = ensure_started(&ctx.store, false);
    spin.finish();
    let info = info?;
    let link = format!("{}/#token={}", info.url, info.token);
    if print {
        ctx.print(&json!({ "url": link }), || link.clone());
    } else {
        open_url(&link);
        ctx.print(&json!({ "url": info.url }), || {
            format!("opened {} in your browser", info.url)
        });
    }
    Ok(Exit::Ok)
}

pub fn run(ctx: &Ctx, action: ServerAction) -> anyhow::Result<Exit> {
    match action {
        ServerAction::List => return super::connect::server_list(ctx),
        ServerAction::Use { url } => return super::connect::server_use(ctx, &url),
        ServerAction::Forget {
            url,
            discard_pending,
        } => return super::connect::server_forget(ctx, &url, discard_pending),
        ServerAction::Start { lan } => {
            let spin = ui::spinner(ctx.json, "starting the local server…");
            let info = ensure_started(&ctx.store, lan);
            spin.finish();
            let info = info?;
            ctx.print(&json!({ "url": info.url, "pid": info.pid }), || {
                format!(
                    "{} server running at {} {}",
                    Mark::Ok.sym(),
                    info.url,
                    ui::dim(&format!("(pid {})", info.pid))
                )
            });
        }
        ServerAction::Stop => {
            let stopped = stop();
            ctx.print(&json!({ "stopped": stopped }), || {
                if stopped {
                    format!("{} server stopped", Mark::Ok.sym())
                } else {
                    format!("{} server was not running", Mark::Info.sym())
                }
            });
        }
        ServerAction::Status => match running(&ctx.store) {
            Some(info) => ctx.print(
                &json!({ "running": true, "url": info.url, "pid": info.pid }),
                || {
                    ui::kv(&[
                        ("server", Mark::Ok.label("running")),
                        ("url", info.url.clone()),
                        ("pid", info.pid.to_string()),
                    ])
                },
            ),
            None => {
                ctx.print(&json!({ "running": false }), || {
                    ui::kv(&[(
                        "server",
                        format!(
                            "{} {} {}",
                            Mark::Info.label("not running"),
                            ui::dim("→"),
                            ui::cmd("pama server start")
                        ),
                    )])
                });
                return Ok(Exit::Network);
            }
        },
    }
    Ok(Exit::Ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    /// Eight callers race to start: exactly one runs `start`; the others wait for the lock,
    /// re-check and see the running server (the bug: two servers, `server.json` overwritten
    /// with the loser's token, 401s).
    #[test]
    fn concurrent_starts_start_one_server() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("home/server.lock");
        let started = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (lock, started, barrier) = (lock.clone(), started.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    start_once(
                        &lock,
                        || match started.load(Ordering::SeqCst) {
                            0 => None,
                            n => Some(n),
                        },
                        || {
                            // A slow start: the others must wait, not start their own.
                            std::thread::sleep(Duration::from_millis(150));
                            Ok(started.fetch_add(1, Ordering::SeqCst) + 1)
                        },
                    )
                    .unwrap()
                })
            })
            .collect();
        let seen: Vec<usize> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(started.load(Ordering::SeqCst), 1);
        assert!(seen.iter().all(|n| *n == 1), "{seen:?}");
    }

    #[test]
    fn a_failed_start_releases_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("server.lock");
        let err = start_once(&lock, || None::<u32>, || anyhow::bail!("exited"));
        assert!(err.is_err());
        // The next caller gets the lock and can start.
        assert_eq!(start_once(&lock, || None, || Ok(7)).unwrap(), 7);
        // Already running: no start at all.
        assert_eq!(
            start_once(
                &lock,
                || Some(1),
                || -> anyhow::Result<u32> { panic!("started") }
            )
            .unwrap(),
            1
        );
    }
}
