//! `pama doctor`: check that capture, the local (or remote) server, models, permissions and
//! offline settings are in order, and say how to fix what is not.

use std::path::Path;

use pama_core::capture::{KEY_CAPTURE_ALL, KEY_CAPTURE_PROJECTS};
use pama_core::client::{Api, LocalApi, KEY_DECLARED_HOSTS, KEY_STRICT_OFFLINE};
use pama_core::paths::home_dir;
use pama_core::session::{claude, codex};
use serde_json::json;

use super::{scan, Ctx};
use crate::Exit;

struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
    fix: Option<String>,
}

/// A Claude settings file with a hook command that runs `pama hook claude`.
fn has_pama_hook(p: &Path) -> bool {
    std::fs::read_to_string(p)
        .map(|s| {
            s.lines()
                .any(|l| l.contains("pama") && l.contains("hook claude"))
        })
        .unwrap_or(false)
}

fn file_contains(p: &Path, needle: &str) -> bool {
    std::fs::read_to_string(p)
        .map(|s| s.contains(needle))
        .unwrap_or(false)
}

/// Remote mode: default server reachable and new enough, this device still logged in, sync on
/// for at least one project.
fn remote_checks(ctx: &Ctx, checks: &mut Vec<Check>) {
    use pama_core::remote;
    pama_core::secrets::init_platform_store();
    let store = &ctx.store;
    let Some(server) = ctx.server.clone().or_else(|| remote::default_server(store)) else {
        checks.push(Check {
            name: "remote server",
            ok: false,
            detail: "not logged in".into(),
            fix: Some("`pama login --server <url>`".into()),
        });
        return;
    };
    let api = Api::remote(store, "cli", &server);
    let health = api
        .as_ref()
        .ok()
        .and_then(|a| a.get("/v1/health", "doctor").ok());
    let drafts = health
        .as_ref()
        .and_then(|h| h["capabilities"].as_array())
        .is_some_and(|c| c.iter().any(|x| x == "drafts"));
    checks.push(Check {
        name: "remote server",
        ok: health.is_some() && drafts,
        detail: match &health {
            Some(h) if drafts => format!(
                "{server} (version {})",
                h["version"].as_str().unwrap_or("?")
            ),
            Some(_) => format!("{server} is too old for remote mode"),
            None => format!("{server} unreachable"),
        },
        fix: Some(if health.is_some() {
            "ask the operator to upgrade the server".into()
        } else {
            "check the network or `pama config set declared_hosts` in strict offline mode".into()
        }),
    });
    let me = api.as_ref().ok().map(|a| a.get("/v1/auth/me", "doctor"));
    checks.push(Check {
        name: "login",
        ok: matches!(me, Some(Ok(_))),
        detail: match &me {
            Some(Ok(_)) => "this device is connected".into(),
            Some(Err(pama_core::client::ApiError::Status { status: 401, .. })) => {
                "this device was revoked".into()
            }
            Some(Err(e)) => e.to_string(),
            None => "no device token in the keychain".into(),
        },
        fix: Some(format!("`pama login --server {server}`")),
    });
    let synced = remote::sync_projects(store);
    checks.push(Check {
        name: "sync projects",
        ok: !synced.is_empty(),
        detail: format!("{} project(s) send drafts", synced.len()),
        fix: Some("`pama init --sync` in a project".into()),
    });
}

pub fn run(ctx: &Ctx, report: bool) -> anyhow::Result<Exit> {
    let mut checks = Vec::new();
    let store = &ctx.store;

    // Capture scope and hooks.
    let all = store.setting(KEY_CAPTURE_ALL)?.as_deref() == Some("true");
    let projects: Vec<String> = store
        .setting(KEY_CAPTURE_PROJECTS)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    checks.push(Check {
        name: "capture",
        ok: all || !projects.is_empty(),
        detail: if all {
            "all projects".into()
        } else {
            format!("{} project(s)", projects.len())
        },
        fix: Some("run `pama init` in a project".into()),
    });
    let user_hook = has_pama_hook(&home_dir().join(".claude/settings.json"));
    let project_hooks = projects
        .iter()
        .filter(|p| has_pama_hook(&Path::new(p).join(".claude/settings.local.json")))
        .count();
    checks.push(Check {
        name: "claude code hook",
        ok: user_hook || project_hooks > 0 || claude::projects_dir().is_none_or(|d| !d.exists()),
        detail: format!("user scope: {user_hook}, projects with hook: {project_hooks}"),
        fix: Some(
            "`pama init --agent claude` (missed sessions are still found by `pama scan`)".into(),
        ),
    });
    let codex_dir = std::env::var_os("CODEX_HOME")
        .map(Into::into)
        .unwrap_or_else(|| home_dir().join(".codex"));
    let codex_used = codex::sessions_dir().is_some_and(|d| d.exists());
    let notify = file_contains(&codex_dir.join("config.toml"), "\"hook\", \"codex\"");
    checks.push(Check {
        name: "codex notify",
        ok: !codex_used || notify,
        detail: if codex_used {
            format!("registered: {notify}")
        } else {
            "Codex not used".into()
        },
        fix: Some("`pama init --agent codex`".into()),
    });
    let counts = store.captures(500)?;
    let failed = counts
        .iter()
        .filter(|c| c.status == pama_core::store::CaptureStatus::Failed)
        .count();
    checks.push(Check {
        name: "captures",
        ok: failed == 0,
        detail: format!("{} captured, {failed} failed", counts.len()),
        fix: Some("see ~/.pama/pama.log for reasons".into()),
    });

    // Where this machine works: the local server, or a remote one (thin client, spec 004).
    let remote_mode = pama_core::remote::mode(store) == pama_core::remote::Mode::Remote;
    checks.push(Check {
        name: "mode",
        ok: true,
        detail: if remote_mode {
            "remote".into()
        } else {
            "local".into()
        },
        fix: None,
    });
    if remote_mode {
        remote_checks(ctx, &mut checks);
    } else {
        let api = LocalApi::connect(store, "cli").ok().filter(|a| a.healthy());
        checks.push(Check {
            name: "local server",
            ok: api.is_some(),
            detail: if api.is_some() {
                "running".into()
            } else {
                "not running".into()
            },
            fix: Some("`pama server start` (or open the desktop app)".into()),
        });
    }
    let provider = store
        .setting("provider.chat.provider")?
        .unwrap_or_else(|| "ollama".into());
    let models_ok = match provider.as_str() {
        "ollama" => {
            let base = store
                .setting("provider.chat.base_url")?
                .unwrap_or_else(|| "http://127.0.0.1:11434".into());
            reqwest::blocking::Client::new()
                .get(format!("{base}/api/tags"))
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .is_ok_and(|r| r.status().is_success())
        }
        p => {
            pama_core::secrets::init_platform_store();
            pama_core::secrets::exists(&format!("provider.{p}.key")).unwrap_or(false)
        }
    };
    checks.push(Check {
        name: if remote_mode {
            "drafting model"
        } else {
            "models"
        },
        ok: models_ok,
        detail: format!("chat provider: {provider}"),
        fix: Some(if provider == "ollama" {
            "start Ollama and `ollama pull bge-m3` plus a chat model".into()
        } else {
            format!("`pama config set provider.{provider}.key <key>`")
        }),
    });

    // Permissions and offline settings.
    #[cfg(target_os = "macos")]
    checks.push(Check {
        name: "accessibility",
        ok: true,
        detail: "checked by the desktop app at start".into(),
        fix: None,
    });
    let strict = store.setting(KEY_STRICT_OFFLINE)?.as_deref() == Some("true");
    let hosts = store.setting(KEY_DECLARED_HOSTS)?.unwrap_or_default();
    checks.push(Check {
        name: "strict offline",
        ok: !strict || !hosts.is_empty() || provider == "ollama",
        detail: if strict {
            format!(
                "on, declared hosts: {}",
                if hosts.is_empty() { "(none)" } else { &hosts }
            )
        } else {
            "off".into()
        },
        fix: Some(
            "`pama config set declared_hosts <host,...>` for your model and sync servers".into(),
        ),
    });
    let outbox = store.outbox_counts()?;
    checks.push(Check {
        name: "sync outbox",
        ok: outbox.dead == 0,
        detail: format!("{} pending, {} failed", outbox.pending, outbox.dead),
        fix: Some("`pama sync status`; failed items were rejected by the server".into()),
    });

    let all_ok = checks.iter().all(|c| c.ok);
    let value = json!(checks
        .iter()
        .map(|c| json!({ "check": c.name, "ok": c.ok, "detail": c.detail, "fix": if c.ok { None } else { c.fix.clone() } }))
        .collect::<Vec<_>>());
    if report {
        // The console's Doctor page (server `GET /v1/doctor`): the checks plus scan and capture state.
        let mut by_status = serde_json::Map::new();
        for c in &counts {
            let n = by_status.entry(c.status.as_str()).or_insert(json!(0));
            *n = json!(n.as_i64().unwrap_or(0) + 1);
        }
        let recent: Vec<_> = counts
            .iter()
            .take(50)
            .map(|c| {
                json!({
                    "id": c.id,
                    "agent": c.agent,
                    "cwd": c.cwd,
                    "status": c.status,
                    "error": c.error,
                    "attempts": c.attempts,
                    "endedAt": c.ended_at,
                })
            })
            .collect();
        let scan: Option<serde_json::Value> = store
            .setting(scan::KEY_LAST_SCAN)?
            .and_then(|s| serde_json::from_str(&s).ok());
        println!(
            "{}",
            json!({
                "ok": all_ok,
                "checks": value,
                "captures": { "total": counts.len(), "byStatus": by_status, "recent": recent },
                "scan": scan,
                "outbox": { "pending": outbox.pending, "failed": outbox.dead },
            })
        );
        return Ok(if all_ok { Exit::Ok } else { Exit::Config });
    }
    ctx.print(&value, || {
        checks
            .iter()
            .map(|c| {
                let mut line = format!(
                    "{} {:<18} {}",
                    if c.ok { "✓" } else { "✗" },
                    c.name,
                    c.detail
                );
                if let (false, Some(f)) = (c.ok, &c.fix) {
                    line.push_str(&format!("\n    → {f}"));
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(if all_ok { Exit::Ok } else { Exit::Config })
}
