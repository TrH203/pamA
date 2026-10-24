//! `pama login`, `pama logout`, `pama mode` (specs/004-thin-client/contracts/cli.md): connect this
//! machine to a remote pamA server with a browser approval, and choose between local and remote
//! mode. The device token lives in the OS keychain only.

use std::io::{BufRead, IsTerminal, Write};

use pama_core::client::Api;
use pama_core::remote::{self, Login, LoginError, Mode};
use pama_core::sync::token_key;
use serde_json::json;

use super::Ctx;
use crate::{Exit, ModeArg};

fn device_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "pama device".into())
}

pub fn login(ctx: &Ctx, no_browser: bool) -> anyhow::Result<Exit> {
    pama_core::secrets::init_platform_store();
    let Some(server) = ctx
        .server
        .clone()
        .or_else(|| std::env::var("PAMA_CLOUD_URL").ok())
        .map(|s| remote::normalize(&s))
    else {
        eprintln!("error: which server? `pama login --server https://pama.example.com`");
        return Ok(Exit::User);
    };
    let flow = Login::new(&ctx.store, &server);
    let start = match flow.start(&device_name()) {
        Ok(s) => s,
        Err(e) => return Ok(login_exit(&e)),
    };
    // On stderr even with --json: the owner needs it to approve.
    eprintln!(
        "Open {} and confirm the code {}",
        start.verification_uri_complete, start.user_code
    );
    if !no_browser {
        super::server::open_url(&start.verification_uri_complete);
    }
    let done = match flow.wait(&start, std::thread::sleep) {
        Ok(d) => d,
        Err(e) => return Ok(login_exit(&e)),
    };
    remote::finish_login(&ctx.store, &server, &done)?;
    ctx.print(
        &json!({ "server": server, "workspace_id": done.workspace_id, "device_id": done.device_id }),
        || {
            format!(
                "logged in to {server}; this machine now works in remote mode.\n\
                 Turn on drafts for a project with `pama init --sync` inside it."
            )
        },
    );
    Ok(Exit::Ok)
}

fn login_exit(e: &LoginError) -> Exit {
    eprintln!("error: {e}");
    match e {
        LoginError::Net(_) => Exit::Network,
        LoginError::Unsupported => Exit::Config,
        _ => Exit::User,
    }
}

pub fn logout(ctx: &Ctx, discard_pending: bool) -> anyhow::Result<Exit> {
    pama_core::secrets::init_platform_store();
    let Some(server) = ctx
        .server
        .clone()
        .map(|s| remote::normalize(&s))
        .or_else(|| remote::default_server(&ctx.store))
    else {
        eprintln!("error: not logged in to any server");
        return Ok(Exit::User);
    };
    // Revoke on the server first (best effort: the token is deleted locally either way).
    let mut revoked = false;
    if let (Ok(api), Some(id)) = (
        Api::remote(&ctx.store, "cli", &server),
        remote::server_entry(&ctx.store, &server).and_then(|e| e.device_id),
    ) {
        // 401: already revoked.
        revoked = matches!(
            api.post(&format!("/v1/devices/{id}/revoke"), "logout", &json!({})),
            Ok(_) | Err(pama_core::client::ApiError::Status { status: 401, .. })
        );
    }
    let _ = pama_core::secrets::delete(&token_key(&server));
    let pending = ctx.store.outbox_pending_for(&server)?;
    let discarded = if discard_pending {
        ctx.store.outbox_discard_for(&server)?
    } else {
        0
    };
    let left = remote::remove_server(&ctx.store, &server)?;
    if left.is_empty() {
        remote::set_mode(&ctx.store, Mode::Local)?;
    }
    ctx.print(
        &json!({ "server": server, "revoked": revoked, "pending": pending, "discarded": discarded }),
        || {
            let mut out = format!("logged out of {server}");
            if !revoked {
                out.push_str(" (could not reach it: revoke this device in the console)");
            }
            if pending > 0 && discarded == 0 {
                out.push_str(&format!(
                    "\n{pending} item(s) wait for delivery and will be sent after the next login"
                ));
            } else if discarded > 0 {
                out.push_str(&format!("\n{discarded} undelivered item(s) dropped"));
            }
            if left.is_empty() {
                out.push_str("\nthis machine is back in local mode");
            }
            out
        },
    );
    Ok(Exit::Ok)
}

fn server_installed() -> bool {
    std::env::var_os("PAMA_SERVER_CMD").is_some()
        || std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.to_path_buf()))
            .is_some_and(|d| {
                d.join(if cfg!(windows) {
                    "pama-server.exe"
                } else {
                    "pama-server"
                })
                .exists()
            })
}

pub fn set_mode(ctx: &Ctx, m: ModeArg) -> anyhow::Result<Result<(), Exit>> {
    match m {
        ModeArg::Remote => {
            if remote::default_server(&ctx.store).is_none() {
                eprintln!("error: log in first: `pama login --server <url>`");
                return Ok(Err(Exit::Config));
            }
            remote::set_mode(&ctx.store, Mode::Remote)?;
        }
        ModeArg::Local => {
            if !server_installed() {
                eprintln!(
                    "warning: local mode needs the local server (`pama-server` next to `pama`); \
                     install the full pamA package"
                );
            }
            remote::set_mode(&ctx.store, Mode::Local)?;
        }
    }
    Ok(Ok(()))
}

pub fn mode(ctx: &Ctx, m: Option<ModeArg>) -> anyhow::Result<Exit> {
    if let Some(m) = m {
        if let Err(code) = set_mode(ctx, m)? {
            return Ok(code);
        }
    }
    let mode = remote::mode(&ctx.store);
    let default = remote::default_server(&ctx.store);
    let servers = remote::servers(&ctx.store);
    ctx.print(
        &json!({ "mode": mode, "default_server": default, "servers": servers }),
        || {
            let mut out = format!("mode: {}", mode.as_str());
            if let Some(d) = &default {
                out.push_str(&format!("\ndefault server: {d}"));
            }
            for s in &servers {
                out.push_str(&format!("\nlogged in: {}", s.url));
            }
            out
        },
    );
    Ok(Exit::Ok)
}

pub fn ask_yes(question: &str) -> bool {
    if !std::io::stdin().is_terminal() {
        return false;
    }
    print!("{question} (y/N): ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    line.trim().eq_ignore_ascii_case("y")
}

fn ask_mode() -> Option<ModeArg> {
    if !std::io::stdin().is_terminal() {
        return None;
    }
    println!("Where should pamA keep your digests?");
    println!("  local  — everything on this machine (needs the local server and a model)");
    println!("  remote — only `pama` here; review and Ask Links on a pamA server");
    print!("mode [local]: ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    Some(match line.trim() {
        "remote" | "r" => ModeArg::Remote,
        _ => ModeArg::Local,
    })
}

/// The mode and per-project sync part of `pama init`. Returns lines describing what changed.
pub fn init_remote(
    ctx: &Ctx,
    dir: &std::path::Path,
    mode_arg: Option<ModeArg>,
    sync: bool,
) -> anyhow::Result<Result<Vec<String>, Exit>> {
    let mut changes = Vec::new();
    let fresh = ctx.store.setting(remote::KEY_MODE)?.is_none();
    let wanted = mode_arg.or_else(|| if fresh && !ctx.json { ask_mode() } else { None });
    if let Some(m) = wanted {
        if m == ModeArg::Remote && remote::default_server(&ctx.store).is_none() {
            eprintln!("error: remote mode needs a server: run `pama login --server <url>` first");
            return Ok(Err(Exit::Config));
        }
        if let Err(code) = set_mode(ctx, m)? {
            return Ok(Err(code));
        }
        changes.push(format!(
            "mode: {}",
            if m == ModeArg::Remote {
                "remote"
            } else {
                "local"
            }
        ));
    }
    if remote::mode(&ctx.store) != Mode::Remote {
        return Ok(Ok(changes));
    }
    let server = remote::default_server(&ctx.store).unwrap_or_default();
    let keys = remote::project_keys(&dir.to_string_lossy());
    let project = keys[0].clone();
    if keys
        .iter()
        .all(|p| remote::sync_enabled(&ctx.store, &p.key))
    {
        return Ok(Ok(changes));
    }
    let on = sync
        || (!ctx.json
            && ask_yes(&format!(
                "Send digest drafts of {} to {server}? Transcripts stay on this machine",
                project.name
            )));
    if on {
        for p in &keys {
            remote::set_project_sync(&ctx.store, &p.key, true)?;
        }
        changes.push(format!("drafts of {} go to {server}", project.key));
    } else {
        eprintln!(
            "note: sync is off for {}; nothing is sent until `pama sync enable --project {}`",
            project.key, project.key
        );
    }
    Ok(Ok(changes))
}
