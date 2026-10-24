//! `pama init`: enable capture for a project and install agent hooks. Idempotent; prints what
//! changed. Committed settings (`.claude/settings.json`) are only edited with `--project-scope`.

use std::path::{Path, PathBuf};

use pama_core::capture::{enable_project, KEY_CAPTURE_ALL};
use pama_core::paths::home_dir;
use serde_json::{json, Value};

use super::Ctx;
use crate::{AgentArg, Exit, ModeArg};

fn hook_command() -> String {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "pama".into());
    if exe.contains(' ') {
        format!("\"{exe}\" hook claude")
    } else {
        format!("{exe} hook claude")
    }
}

/// Add our SessionEnd hook to a Claude settings file. Returns true if the file changed.
pub fn install_claude_hook(settings: &Path, command: &str) -> anyhow::Result<bool> {
    let mut doc: Value = match std::fs::read_to_string(settings) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s)?,
        _ => json!({}),
    };
    let hooks = doc
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("{} is not a JSON object", settings.display()))?
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let list = hooks
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("hooks is not an object"))?
        .entry("SessionEnd")
        .or_insert_with(|| json!([]));
    let arr = list
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("hooks.SessionEnd is not a list"))?;
    let present = arr.iter().any(|m| {
        m["hooks"].as_array().is_some_and(|hs| {
            hs.iter().any(|h| {
                h["command"]
                    .as_str()
                    .is_some_and(|c| c.contains("hook claude"))
            })
        })
    });
    if present {
        return Ok(false);
    }
    arr.push(json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] }));
    if let Some(d) = settings.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(settings, serde_json::to_string_pretty(&doc)? + "\n")?;
    Ok(true)
}

/// Register `pama hook codex` as Codex's `notify` program. Never overwrites another notifier.
pub fn install_codex_notify(config: &Path, exe: &str) -> anyhow::Result<Result<bool, String>> {
    let text = std::fs::read_to_string(config).unwrap_or_default();
    let has_notify = text.lines().any(|l| l.trim_start().starts_with("notify"));
    if has_notify {
        if text.contains("hook\", \"codex\"") || text.contains("hook', 'codex'") {
            return Ok(Ok(false));
        }
        return Ok(Err(format!(
            "{} already has a `notify` program; add `{exe} hook codex` to it manually",
            config.display()
        )));
    }
    // Top-level keys must come before any [table], so prepend.
    let line = format!(
        "notify = [{}, \"hook\", \"codex\"]\n",
        serde_json::to_string(exe)?
    );
    if let Some(d) = config.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(config, format!("{line}{text}"))?;
    Ok(Ok(true))
}

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

    if matches!(agent, AgentArg::Claude | AgentArg::All) {
        let settings = if global {
            home_dir().join(".claude/settings.json")
        } else if project_scope {
            dir.join(".claude/settings.json")
        } else {
            dir.join(".claude/settings.local.json")
        };
        if install_claude_hook(&settings, &hook_command())? {
            changes.push(format!(
                "Claude Code SessionEnd hook added to {}",
                settings.display()
            ));
        }
    }
    if matches!(agent, AgentArg::Codex | AgentArg::All) {
        let config = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".codex"))
            .join("config.toml");
        let exe = std::env::current_exe()?.to_string_lossy().into_owned();
        match install_codex_notify(&config, &exe)? {
            Ok(true) => changes.push(format!("Codex notify registered in {}", config.display())),
            Ok(false) => {}
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_hook_is_merged_once_and_keeps_other_settings() {
        let dir = std::env::temp_dir().join(format!("pama-init-{}", ulid::Ulid::generate()));
        let f = dir.join(".claude/settings.local.json");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(
            &f,
            r#"{"permissions":{"allow":["Bash(ls)"]},"hooks":{"Stop":[]}}"#,
        )
        .unwrap();
        assert!(install_claude_hook(&f, "/bin/pama hook claude").unwrap());
        assert!(
            !install_claude_hook(&f, "/bin/pama hook claude").unwrap(),
            "idempotent"
        );
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["permissions"]["allow"][0], "Bash(ls)");
        assert_eq!(
            v["hooks"]["SessionEnd"][0]["hooks"][0]["command"],
            "/bin/pama hook claude"
        );
        assert!(v["hooks"]["Stop"].is_array());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codex_notify_is_prepended_and_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("pama-codex-{}", ulid::Ulid::generate()));
        let f = dir.join("config.toml");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&f, "[model_providers.x]\nname = \"x\"\n").unwrap();
        assert_eq!(install_codex_notify(&f, "/bin/pama").unwrap(), Ok(true));
        let text = std::fs::read_to_string(&f).unwrap();
        assert!(
            text.starts_with("notify = [\"/bin/pama\", \"hook\", \"codex\"]\n[model_providers.x]")
        );
        assert_eq!(install_codex_notify(&f, "/bin/pama").unwrap(), Ok(false));
        std::fs::write(&f, "notify = [\"other\"]\n").unwrap();
        assert!(install_codex_notify(&f, "/bin/pama").unwrap().is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
