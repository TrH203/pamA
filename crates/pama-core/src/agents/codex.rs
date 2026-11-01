//! Codex CLI: rollouts under `$CODEX_HOME/sessions`, and `notify` in `$CODEX_HOME/config.toml`
//! (user scope only; capture is still limited to the projects enabled with `pama init`). When
//! another notifier is configured, pamA chains it: `notify = [pama, "hook", "codex", "--chain",
//! <original argv…>]`, and `pama hook codex` runs the original program with the same JSON.
//! Uninstalling restores the original line.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{
    home, jsonl_files, mtime, AgentAdapter, FoundSession, HookError, HookScope, Installed,
};
use crate::digest::Agent;
use crate::session::reader::ReadError;
use crate::session::{codex, NormalizedSession};

pub struct CodexAdapter;

pub const CHAIN_FLAG: &str = "--chain";

pub fn config_file() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".codex"))
        .join("config.toml")
}

/// The `notify` argv on a single `notify = [...]` line, if parseable.
fn parse_notify(line: &str) -> Option<Vec<String>> {
    let v: toml::Table = toml::from_str(line).ok()?;
    v.get("notify")?
        .as_array()?
        .iter()
        .map(|x| x.as_str().map(String::from))
        .collect()
}

fn notify_line(argv: &[String]) -> String {
    format!(
        "notify = [{}]",
        argv.iter()
            .map(|a| serde_json::to_string(a).expect("json"))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn is_ours(argv: &[String]) -> bool {
    argv.len() >= 3 && argv[1] == "hook" && argv[2] == "codex"
}

/// `rollout-<ts>-<uuid>.jsonl` → `<uuid>` (last five dash-separated groups).
pub fn session_id(file: &Path) -> String {
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() >= 5 {
        parts[parts.len() - 5..].join("-")
    } else {
        stem
    }
}

/// Register `pama hook codex` as Codex's `notify` program, chaining an existing notifier.
/// Returns true when the file changed.
pub fn install_into(config: &Path, exe: &str) -> Result<bool, HookError> {
    let text = std::fs::read_to_string(config).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    let ours = vec![exe.to_string(), "hook".into(), "codex".into()];
    if let Some(i) = lines
        .iter()
        .position(|l| l.trim_start().starts_with("notify"))
    {
        let Some(argv) = parse_notify(&lines[i]) else {
            return Err(HookError::Config(format!(
                "{} has a `notify` setting pamA cannot read (multi-line?); add `{exe} hook codex` to it manually",
                config.display()
            )));
        };
        if is_ours(&argv) {
            return Ok(false);
        }
        let mut chained = ours;
        chained.push(CHAIN_FLAG.into());
        chained.extend(argv);
        lines[i] = notify_line(&chained);
    } else {
        // Top-level keys must come before any [table], so prepend.
        lines.insert(0, notify_line(&ours));
    }
    if let Some(d) = config.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(config, lines.join("\n") + "\n")?;
    Ok(true)
}

/// Remove our `notify`, restoring a chained notifier. Returns true when the file changed.
pub fn uninstall_from(config: &Path) -> Result<bool, HookError> {
    let Ok(text) = std::fs::read_to_string(config) else {
        return Ok(false);
    };
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    let Some(i) = lines
        .iter()
        .position(|l| l.trim_start().starts_with("notify"))
    else {
        return Ok(false);
    };
    let Some(argv) = parse_notify(&lines[i]).filter(|a| is_ours(a)) else {
        return Ok(false);
    };
    if argv.get(3).map(String::as_str) == Some(CHAIN_FLAG) && argv.len() > 4 {
        lines[i] = notify_line(&argv[4..]);
    } else {
        lines.remove(i);
    }
    std::fs::write(config, lines.join("\n") + "\n")?;
    Ok(true)
}

pub fn present_in(config: &Path) -> bool {
    std::fs::read_to_string(config)
        .map(|s| s.contains("\"hook\", \"codex\"") || s.contains("hook', 'codex'"))
        .unwrap_or(false)
}

/// Split `pama hook codex` arguments into (chained argv, notification JSON).
pub fn split_hook_args(args: &[String]) -> (Vec<String>, Option<String>) {
    match args {
        [] => (Vec::new(), None),
        [flag, rest @ ..] if flag == CHAIN_FLAG => match rest.split_last() {
            Some((last, chain)) if last.trim_start().starts_with('{') => {
                (chain.to_vec(), Some(last.clone()))
            }
            _ => (rest.to_vec(), None),
        },
        [.., last] => (Vec::new(), Some(last.clone())),
    }
}

impl AgentAdapter for CodexAdapter {
    fn agent(&self) -> Agent {
        Agent::Codex
    }
    fn cli_id(&self) -> &'static str {
        "codex"
    }
    fn display_name(&self) -> &'static str {
        "Codex"
    }
    fn transcript_dirs(&self) -> Vec<PathBuf> {
        codex::sessions_dir().into_iter().collect()
    }
    fn sessions(&self) -> Vec<FoundSession> {
        let mut files = Vec::new();
        for d in self.transcript_dirs() {
            jsonl_files(&d, 3, &mut files);
        }
        files
            .into_iter()
            .map(|f| FoundSession {
                session_id: session_id(&f),
                updated: mtime(&f),
                location: f.to_string_lossy().into_owned(),
            })
            .collect()
    }
    fn parse(&self, location: &str) -> Result<NormalizedSession, ReadError> {
        codex::parse(Path::new(location))
    }
    fn supports_scope(&self, scope: &HookScope) -> bool {
        matches!(scope, HookScope::Global)
    }
    fn hook_file(&self, scope: &HookScope) -> Option<PathBuf> {
        self.supports_scope(scope).then(config_file)
    }
    fn install_hook(&self, _scope: &HookScope, exe: &str) -> Result<Installed, HookError> {
        let f = config_file();
        Ok(if install_into(&f, exe)? {
            Installed::Added(f)
        } else {
            Installed::Unchanged(f)
        })
    }
    fn uninstall_hook(&self, scope: &HookScope) -> Result<bool, HookError> {
        if !self.supports_scope(scope) {
            return Ok(false);
        }
        uninstall_from(&config_file())
    }
    fn hook_installed(&self, scope: &HookScope) -> bool {
        self.supports_scope(scope) && present_in(&config_file())
    }
    fn idle_delay(&self, session_end: bool) -> Duration {
        // `notify` fires after every turn: wait for the session to go idle.
        if session_end {
            Duration::ZERO
        } else {
            Duration::from_secs(120)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notify_is_prepended_chained_and_restored() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("config.toml");
        std::fs::write(&f, "[model_providers.x]\nname = \"x\"\n").unwrap();
        assert!(install_into(&f, "/bin/pama").unwrap());
        let text = std::fs::read_to_string(&f).unwrap();
        assert!(
            text.starts_with("notify = [\"/bin/pama\", \"hook\", \"codex\"]\n[model_providers.x]")
        );
        assert!(!install_into(&f, "/bin/pama").unwrap());
        assert!(present_in(&f));
        assert!(uninstall_from(&f).unwrap());
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "[model_providers.x]\nname = \"x\"\n"
        );

        // Another notifier: chained, then restored exactly.
        std::fs::write(
            &f,
            "notify = [\"notify-send\", \"Codex\"]\nmodel = \"o3\"\n",
        )
        .unwrap();
        assert!(install_into(&f, "/bin/pama").unwrap());
        let text = std::fs::read_to_string(&f).unwrap();
        assert!(text.starts_with(
            "notify = [\"/bin/pama\", \"hook\", \"codex\", \"--chain\", \"notify-send\", \"Codex\"]"
        ));
        assert!(!install_into(&f, "/bin/pama").unwrap());
        assert!(uninstall_from(&f).unwrap());
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "notify = [\"notify-send\", \"Codex\"]\nmodel = \"o3\"\n"
        );

        // Unreadable notify: refuse rather than break it.
        std::fs::write(&f, "notify = [\n  \"x\",\n]\n").unwrap();
        assert!(install_into(&f, "/bin/pama").is_err());
    }

    #[test]
    fn hook_args_split_chain_and_json() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            split_hook_args(&s(&["{\"type\":\"x\"}"])),
            (vec![], Some("{\"type\":\"x\"}".into()))
        );
        assert_eq!(
            split_hook_args(&s(&["--chain", "notify-send", "Codex", "{\"a\":1}"])),
            (s(&["notify-send", "Codex"]), Some("{\"a\":1}".into()))
        );
        assert_eq!(split_hook_args(&[]), (vec![], None));
    }

    #[test]
    fn codex_has_user_scope_only() {
        let a = CodexAdapter;
        assert!(a.supports_scope(&HookScope::Global));
        assert!(!a.supports_scope(&HookScope::Project {
            dir: "/p".into(),
            shared: false
        }));
        assert_eq!(
            session_id(Path::new(
                "rollout-2025-01-01T00-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"
            )),
            "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
        );
    }
}
