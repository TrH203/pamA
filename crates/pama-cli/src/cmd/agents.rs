//! `pama agents [list] | enable <id> | disable <id> | uninstall <id>` (spec 005): the coding
//! agents pamA reads, whether capture is on for each, and where their hooks are installed.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use pama_core::agents::{self, AgentAdapter, HookScope, Installed};
use pama_core::capture::enable_project;
use pama_core::store::Store;
use serde_json::{json, Value};

use super::Ctx;
use crate::{AgentsAction, Exit};

const RECENT: Duration = Duration::from_secs(7 * 86_400);

fn exe() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "pama".into())
}

fn lookup(id: &str) -> Option<&'static dyn AgentAdapter> {
    let a = agents::by_id(id);
    if a.is_none() {
        eprintln!(
            "error: unknown agent {id} (one of: {})",
            agents::all()
                .iter()
                .map(|a| a.cli_id())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    a
}

pub fn status_value(store: &Store) -> Value {
    let captures = store.captures(5_000).unwrap_or_default();
    let rows: Vec<Value> = agents::all()
        .iter()
        .map(|a| {
            let now = SystemTime::now();
            let recent = a
                .sessions()
                .iter()
                .filter(|s| now.duration_since(s.updated).unwrap_or_default() <= RECENT)
                .count();
            let captured = captures.iter().filter(|c| c.agent == a.agent()).count();
            json!({
                "id": a.cli_id(),
                "agent": a.agent().as_str(),
                "name": a.display_name(),
                "detected": a.detected(),
                "enabled": agents::enabled(store, a.agent()),
                "hooks": agents::hook_locations(store, *a),
                "transcript_dirs": a.transcript_dirs(),
                "recent_sessions": recent,
                "captured": captured,
            })
        })
        .collect();
    json!({ "agents": rows })
}

fn list(ctx: &Ctx) -> Exit {
    let v = status_value(&ctx.store);
    ctx.print(&v, || {
        let mut out = String::new();
        for r in v["agents"].as_array().into_iter().flatten() {
            let hooks = r["hooks"].as_array().cloned().unwrap_or_default();
            out.push_str(&format!(
                "{} {:<12} {:<12} {:<4} hook: {:<28} {} session(s) in 7 days, {} captured\n",
                if r["enabled"] == true { "●" } else { "○" },
                r["name"].as_str().unwrap_or(""),
                if r["detected"] == true {
                    "detected"
                } else {
                    "not found"
                },
                if r["enabled"] == true { "on" } else { "off" },
                if hooks.is_empty() {
                    "none (scan only)".to_string()
                } else {
                    hooks
                        .iter()
                        .map(|h| h["scope"].as_str().unwrap_or("").to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                },
                r["recent_sessions"],
                r["captured"],
            ));
        }
        out.push_str("turn one on with `pama agents enable <id> [--global|--project <dir>]`");
        out
    });
    Exit::Ok
}

/// Install `a`'s hook at `scope`; Codex falls back to its user scope.
pub fn install(a: &dyn AgentAdapter, scope: &HookScope) -> Result<Installed, String> {
    let scope = if a.supports_scope(scope) {
        scope.clone()
    } else {
        HookScope::Global
    };
    a.install_hook(&scope, &exe()).map_err(|e| e.to_string())
}

pub fn run(ctx: &Ctx, action: Option<AgentsAction>) -> anyhow::Result<Exit> {
    match action.unwrap_or(AgentsAction::List) {
        AgentsAction::List => Ok(list(ctx)),
        AgentsAction::Enable {
            id,
            global,
            project,
            shared,
        } => {
            let Some(a) = lookup(&id) else {
                return Ok(Exit::User);
            };
            let scope = if global {
                HookScope::Global
            } else {
                let dir = match project {
                    Some(p) => PathBuf::from(p),
                    None => std::env::current_dir()?,
                };
                let dir = dir.canonicalize().unwrap_or(dir);
                HookScope::Project { dir, shared }
            };
            let mut changes = Vec::new();
            agents::set_enabled(&ctx.store, a.agent(), true)?;
            changes.push(format!("capture on for {}", a.display_name()));
            if let HookScope::Project { dir, .. } = &scope {
                if enable_project(&ctx.store, &dir.to_string_lossy())? {
                    changes.push(format!("capture enabled for {}", dir.display()));
                }
            }
            if !a.supports_scope(&scope) {
                changes.push(format!(
                    "{} hooks are user-wide; capture stays limited to enabled projects",
                    a.display_name()
                ));
            }
            match install(a, &scope) {
                Ok(Installed::Added(f)) => {
                    changes.push(format!("hook added to {}", f.display()))
                }
                Ok(Installed::Unchanged(f)) => {
                    changes.push(format!("hook already in {}", f.display()))
                }
                Err(e) => {
                    eprintln!("warning: {e}; sessions are still found by `pama scan`");
                }
            }
            ctx.print(&json!({ "agent": a.cli_id(), "changes": changes }), || {
                changes
                    .iter()
                    .map(|c| format!("✓ {c}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            Ok(Exit::Ok)
        }
        AgentsAction::Disable { id } => {
            let Some(a) = lookup(&id) else {
                return Ok(Exit::User);
            };
            agents::set_enabled(&ctx.store, a.agent(), false)?;
            ctx.print(&json!({ "agent": a.cli_id(), "enabled": false }), || {
                format!(
                    "capture off for {}; its hooks are ignored (remove them with `pama agents uninstall {}`)",
                    a.display_name(),
                    a.cli_id()
                )
            });
            Ok(Exit::Ok)
        }
        AgentsAction::Uninstall { id } => {
            let Some(a) = lookup(&id) else {
                return Ok(Exit::User);
            };
            let mut removed = Vec::new();
            let mut errors = Vec::new();
            for s in agents::scopes_to_check(&ctx.store) {
                if !a.supports_scope(&s) {
                    continue;
                }
                let file = a.hook_file(&s);
                match a.uninstall_hook(&s) {
                    Ok(true) => removed.extend(file.map(|f| f.display().to_string())),
                    Ok(false) => {}
                    Err(e) => errors.push(e.to_string()),
                }
            }
            for e in &errors {
                eprintln!("warning: {e}");
            }
            ctx.print(
                &json!({ "agent": a.cli_id(), "removed": removed, "errors": errors }),
                || {
                    if removed.is_empty() {
                        format!("no pamA hook found for {}", a.display_name())
                    } else {
                        removed
                            .iter()
                            .map(|f| format!("✓ hook removed from {f}"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    }
                },
            );
            Ok(if errors.is_empty() {
                Exit::Ok
            } else {
                Exit::Config
            })
        }
    }
}
