//! `pama init`: enable capture for a project and install agent hooks. Idempotent; prints what
//! changed. Committed settings (`.claude/settings.json`) are only edited with `--project-scope`.

use std::path::PathBuf;

use pama_core::agents::{self, AgentAdapter, HookScope, Installed};
use pama_core::capture::{enable_project, KEY_CAPTURE_ALL};
use pama_core::digest::Agent;
use serde_json::json;

use super::Ctx;
use crate::{AgentArg, Exit, ModeArg};

pub fn run(
    ctx: &Ctx,
    project: Option<String>,
    agent: AgentArg,
    global: bool,
    project_scope: bool,
    mode: Option<ModeArg>,
    sync: bool,
) -> anyhow::Result<Exit> {
    let explicit = project.is_some();
    let dir: PathBuf = match project {
        Some(p) => PathBuf::from(p),
        None => std::env::current_dir()?,
    };
    let dir = dir.canonicalize().unwrap_or(dir);
    let mut changes: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    if global {
        ctx.store.set_setting(KEY_CAPTURE_ALL, "true")?;
        changes.push("capture enabled for all projects".into());
    } else if enable_project(&ctx.store, &dir.to_string_lossy())? {
        changes.push(format!("capture enabled for {}", dir.display()));
    }

    // Hooks go through the agent adapters (spec 005). Codex is user-scope only.
    let scope = if global {
        HookScope::Global
    } else {
        HookScope::Project {
            dir: dir.clone(),
            shared: project_scope,
        }
    };
    let chosen: Vec<&dyn AgentAdapter> = match agent {
        AgentArg::Claude => vec![agents::adapter(Agent::ClaudeCode)],
        AgentArg::Codex => vec![agents::adapter(Agent::Codex)],
        AgentArg::Cursor => vec![agents::adapter(Agent::Cursor)],
        AgentArg::Opencode => vec![agents::adapter(Agent::OpenCode)],
        // Claude Code and Codex as before; newer agents only when used on this machine.
        AgentArg::All => agents::all()
            .into_iter()
            .filter(|a| matches!(a.agent(), Agent::ClaudeCode | Agent::Codex) || a.detected())
            .collect(),
    };
    for a in chosen {
        if !agents::enabled(&ctx.store, a.agent()) {
            continue;
        }
        match super::agents::install(a, &scope) {
            Ok(Installed::Added(f)) => changes.push(match a.agent() {
                Agent::ClaudeCode => format!("Claude Code SessionEnd hook added to {}", f.display()),
                Agent::Codex => format!("Codex notify registered in {}", f.display()),
                _ => format!("{} hook added to {}", a.display_name(), f.display()),
            }),
            Ok(Installed::Unchanged(_)) => {}
            Err(w) => warnings.push(w),
        }
    }
    // The agent reports the shell's (logical) directory: prefer it over the canonical path.
    let logical = std::env::var("PWD")
        .ok()
        .filter(|p| !explicit && std::fs::canonicalize(p).ok().as_deref() == Some(dir.as_path()))
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.clone());
    match super::login::init_remote(ctx, &logical, mode, sync)? {
        Ok(more) => changes.extend(more),
        Err(code) => return Ok(code),
    }
    for w in &warnings {
        eprintln!("warning: {w}");
    }
    ctx.print(&json!({ "changes": changes, "warnings": warnings }), || {
        if changes.is_empty() {
            "already set up, nothing changed".into()
        } else {
            changes
                .iter()
                .map(|c| format!("✓ {c}"))
                .collect::<Vec<_>>()
                .join("\n")
        }
    });
    Ok(Exit::Ok)
}
