//! OpenCode: sessions in `~/.local/share/opencode` (SQLite since 1.2, JSON files before), and a
//! plugin as the hook (opencode.ai/docs/plugins): `~/.config/opencode/plugins/pama.js` (user) or
//! `<project>/.opencode/plugins/pama.js` (project). The plugin runs `pama hook opencode <json>`
//! on `session.idle`, which fires after every turn, so captures are debounced.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{home, AgentAdapter, FoundSession, HookError, HookScope, Installed};
use crate::digest::Agent;
use crate::session::reader::ReadError;
use crate::session::{opencode, NormalizedSession};

pub struct OpenCodeAdapter;

pub const PLUGIN_FILE: &str = "pama.js";
const MARK: &str = "pamA capture plugin";

/// The plugin pamA installs. `exe` is embedded as a JSON string literal.
pub fn plugin_source(exe: &str) -> String {
    let exe = serde_json::to_string(exe).expect("json");
    format!(
        r#"// {MARK}: tells pamA when an OpenCode session goes idle so it can draft a digest.
// Installed by `pama agents enable opencode`; remove with `pama agents uninstall opencode`.
// It passes only the session id and directory; pamA reads the session from OpenCode's storage.
const PAMA = {exe};

export const PamaCapture = async ({{ $, directory }}) => ({{
  event: async ({{ event }}) => {{
    if (event.type !== "session.idle") return;
    const payload = JSON.stringify({{
      hook_event_name: "session.idle",
      session_id: event.properties?.sessionID,
      cwd: directory,
    }});
    try {{
      await $`${{PAMA}} hook opencode ${{payload}}`.quiet().nothrow();
    }} catch {{
      // A hook must never break the agent.
    }}
  }},
}});
"#
    )
}

fn config_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(d).join("opencode");
    }
    home().join(".config/opencode")
}

pub fn present_in(f: &Path) -> bool {
    std::fs::read_to_string(f)
        .map(|s| s.contains(MARK))
        .unwrap_or(false)
}

impl AgentAdapter for OpenCodeAdapter {
    fn agent(&self) -> Agent {
        Agent::OpenCode
    }
    fn cli_id(&self) -> &'static str {
        "opencode"
    }
    fn display_name(&self) -> &'static str {
        "OpenCode"
    }
    fn transcript_dirs(&self) -> Vec<PathBuf> {
        opencode::data_dir().into_iter().collect()
    }
    fn sessions(&self) -> Vec<FoundSession> {
        self.transcript_dirs()
            .iter()
            .flat_map(|d| opencode::sessions(d))
            .map(|s| FoundSession {
                session_id: s.id,
                location: s.location,
                updated: s.updated,
            })
            .collect()
    }
    fn parse(&self, location: &str) -> Result<NormalizedSession, ReadError> {
        opencode::parse(location)
    }
    fn hook_file(&self, scope: &HookScope) -> Option<PathBuf> {
        Some(match scope {
            HookScope::Global => config_dir().join("plugins").join(PLUGIN_FILE),
            HookScope::Project { dir, .. } => dir.join(".opencode/plugins").join(PLUGIN_FILE),
        })
    }
    fn install_hook(&self, scope: &HookScope, exe: &str) -> Result<Installed, HookError> {
        let f = self.hook_file(scope).expect("opencode has every scope");
        let src = plugin_source(exe);
        if std::fs::read_to_string(&f).ok().as_deref() == Some(src.as_str()) {
            return Ok(Installed::Unchanged(f));
        }
        if f.exists() && !present_in(&f) {
            return Err(HookError::Config(format!(
                "{} exists and was not written by pamA",
                f.display()
            )));
        }
        if let Some(d) = f.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(&f, src)?;
        Ok(Installed::Added(f))
    }
    fn uninstall_hook(&self, scope: &HookScope) -> Result<bool, HookError> {
        let f = self.hook_file(scope).expect("opencode has every scope");
        if !present_in(&f) {
            return Ok(false);
        }
        std::fs::remove_file(&f)?;
        Ok(true)
    }
    fn hook_installed(&self, scope: &HookScope) -> bool {
        self.hook_file(scope).is_some_and(|f| present_in(&f))
    }
    fn idle_delay(&self, _session_end: bool) -> Duration {
        Duration::from_secs(120)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_installs_once_and_removes_only_its_own_file() {
        let dir = tempfile::tempdir().unwrap();
        let a = OpenCodeAdapter;
        let scope = HookScope::Project {
            dir: dir.path().to_path_buf(),
            shared: false,
        };
        assert!(matches!(
            a.install_hook(&scope, "/bin/pa ma").unwrap(),
            Installed::Added(_)
        ));
        assert!(matches!(
            a.install_hook(&scope, "/bin/pa ma").unwrap(),
            Installed::Unchanged(_)
        ));
        let f = a.hook_file(&scope).unwrap();
        let src = std::fs::read_to_string(&f).unwrap();
        assert!(src.contains("const PAMA = \"/bin/pa ma\";"));
        assert!(src.contains("session.idle"));
        assert!(a.hook_installed(&scope));
        assert!(a.uninstall_hook(&scope).unwrap());
        assert!(!f.exists());
        // Someone else's file of the same name is left alone.
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, "export const Mine = 1;").unwrap();
        assert!(a.install_hook(&scope, "/bin/pama").is_err());
        assert!(!a.uninstall_hook(&scope).unwrap());
        assert!(f.exists());
    }
}
