//! Cursor (editor agent and `cursor-agent` CLI): transcripts under
//! `~/.cursor/projects/<slug>/agent-transcripts/`, hooks in `~/.cursor/hooks.json` (user) or
//! `<project>/.cursor/hooks.json` (project), format `{"version": 1, "hooks": {"<event>":
//! [{"command": "…"}]}}` (cursor.com/docs/agent/hooks). pamA listens to `stop` (end of an agent
//! loop, repeats per turn, so it is debounced) and `sessionEnd` (conversation closed). Every hook
//! gets `conversation_id`, `transcript_path` and `workspace_roots` on stdin.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::{
    home, mtime, read_json_doc, shell_command, write_json_doc, AgentAdapter, FoundSession,
    HookError, HookScope, Installed,
};
use crate::digest::Agent;
use crate::session::reader::ReadError;
use crate::session::{cursor, NormalizedSession};

pub struct CursorAdapter;

const MARK: &str = "hook cursor";
pub const EVENTS: [&str; 2] = ["stop", "sessionEnd"];

fn is_ours(h: &Value) -> bool {
    h["command"].as_str().is_some_and(|c| c.contains(MARK))
}

pub fn install_into(file: &Path, command: &str) -> Result<bool, HookError> {
    let mut doc = read_json_doc(file)?;
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| HookError::Config(format!("{} is not a JSON object", file.display())))?;
    obj.entry("version").or_insert(json!(1));
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| HookError::Config("hooks is not an object".into()))?;
    let mut changed = false;
    for ev in EVENTS {
        let arr = hooks
            .entry(ev)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| HookError::Config(format!("hooks.{ev} is not a list")))?;
        if !arr.iter().any(is_ours) {
            arr.push(json!({ "command": command, "timeout": 5 }));
            changed = true;
        }
    }
    if changed {
        write_json_doc(file, &doc)?;
    }
    Ok(changed)
}

pub fn uninstall_from(file: &Path) -> Result<bool, HookError> {
    if !file.exists() {
        return Ok(false);
    }
    let mut doc = read_json_doc(file)?;
    let Some(hooks) = doc.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let mut changed = false;
    for ev in EVENTS {
        if let Some(arr) = hooks.get_mut(ev).and_then(Value::as_array_mut) {
            let n = arr.len();
            arr.retain(|h| !is_ours(h));
            changed |= arr.len() != n;
            if arr.is_empty() {
                hooks.remove(ev);
            }
        }
    }
    if changed {
        write_json_doc(file, &doc)?;
    }
    Ok(changed)
}

pub fn present_in(file: &Path) -> bool {
    std::fs::read_to_string(file)
        .map(|s| s.contains(MARK))
        .unwrap_or(false)
}

impl AgentAdapter for CursorAdapter {
    fn agent(&self) -> Agent {
        Agent::Cursor
    }
    fn cli_id(&self) -> &'static str {
        "cursor"
    }
    fn display_name(&self) -> &'static str {
        "Cursor"
    }
    fn transcript_dirs(&self) -> Vec<PathBuf> {
        cursor::projects_dir().into_iter().collect()
    }
    fn sessions(&self) -> Vec<FoundSession> {
        self.transcript_dirs()
            .iter()
            .flat_map(|d| cursor::transcripts(d))
            .map(|(id, f)| FoundSession {
                session_id: id,
                updated: mtime(&f),
                location: f.to_string_lossy().into_owned(),
            })
            .collect()
    }
    fn parse(&self, location: &str) -> Result<NormalizedSession, ReadError> {
        cursor::parse(Path::new(location))
    }
    fn hook_file(&self, scope: &HookScope) -> Option<PathBuf> {
        Some(match scope {
            HookScope::Global => std::env::var_os("CURSOR_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home().join(".cursor"))
                .join("hooks.json"),
            // Cursor has one project file; it is committed or not as the team decides.
            HookScope::Project { dir, .. } => dir.join(".cursor/hooks.json"),
        })
    }
    fn install_hook(&self, scope: &HookScope, exe: &str) -> Result<Installed, HookError> {
        let f = self.hook_file(scope).expect("cursor has every scope");
        Ok(if install_into(&f, &shell_command(exe, MARK))? {
            Installed::Added(f)
        } else {
            Installed::Unchanged(f)
        })
    }
    fn uninstall_hook(&self, scope: &HookScope) -> Result<bool, HookError> {
        uninstall_from(&self.hook_file(scope).expect("cursor has every scope"))
    }
    fn hook_installed(&self, scope: &HookScope) -> bool {
        self.hook_file(scope).is_some_and(|f| present_in(&f))
    }
    fn idle_delay(&self, session_end: bool) -> Duration {
        if session_end {
            Duration::from_secs(3)
        } else {
            Duration::from_secs(120)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_json_is_merged_and_cleaned() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join(".cursor/hooks.json");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(
            &f,
            r#"{"version":1,"hooks":{"stop":[{"command":"./audit.sh"}]}}"#,
        )
        .unwrap();
        assert!(install_into(&f, "/bin/pama hook cursor").unwrap());
        assert!(!install_into(&f, "/bin/pama hook cursor").unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["hooks"]["stop"].as_array().unwrap().len(), 2);
        assert_eq!(v["hooks"]["sessionEnd"][0]["command"], "/bin/pama hook cursor");
        assert!(present_in(&f));
        assert!(uninstall_from(&f).unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["hooks"]["stop"][0]["command"], "./audit.sh");
        assert!(v["hooks"].get("sessionEnd").is_none());
        assert_eq!(v["version"], 1);
    }
}
