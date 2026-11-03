//! Claude Code: transcripts under `~/.claude/projects`, a `SessionEnd` command hook in
//! `settings.json` (user), `.claude/settings.local.json` (project) or `.claude/settings.json`
//! (project, shared).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::{
    home, jsonl_files, mtime, read_json_doc, shell_command, write_json_doc, AgentAdapter,
    FoundSession, HookError, HookScope, Installed,
};
use crate::digest::Agent;
use crate::session::reader::ReadError;
use crate::session::{claude, NormalizedSession};

pub struct ClaudeAdapter;

const MARK: &str = "hook claude";

fn is_ours(h: &Value) -> bool {
    h["command"]
        .as_str()
        .is_some_and(super::is_pama_command(MARK))
}

/// Add our SessionEnd hook to a Claude settings file. Returns true if the file changed.
pub fn install_into(settings: &Path, command: &str) -> Result<bool, HookError> {
    let mut doc = read_json_doc(settings)?;
    let hooks = doc
        .as_object_mut()
        .ok_or_else(|| HookError::Config(format!("{} is not a JSON object", settings.display())))?
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let list = hooks
        .as_object_mut()
        .ok_or_else(|| HookError::Config("hooks is not an object".into()))?
        .entry("SessionEnd")
        .or_insert_with(|| json!([]));
    let arr = list
        .as_array_mut()
        .ok_or_else(|| HookError::Config("hooks.SessionEnd is not a list".into()))?;
    let present = arr.iter().any(|m| {
        m["hooks"]
            .as_array()
            .is_some_and(|hs| hs.iter().any(is_ours))
    });
    if present {
        return Ok(false);
    }
    arr.push(json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] }));
    write_json_doc(settings, &doc)?;
    Ok(true)
}

/// Remove our hook entries; drop matchers and lists left empty. Returns true if changed.
pub fn uninstall_from(settings: &Path) -> Result<bool, HookError> {
    if !settings.exists() {
        return Ok(false);
    }
    let mut doc = read_json_doc(settings)?;
    let Some(arr) = doc
        .get_mut("hooks")
        .and_then(|h| h.get_mut("SessionEnd"))
        .and_then(Value::as_array_mut)
    else {
        return Ok(false);
    };
    let before = arr.clone();
    for m in arr.iter_mut() {
        if let Some(hs) = m.get_mut("hooks").and_then(Value::as_array_mut) {
            hs.retain(|h| !is_ours(h));
        }
    }
    arr.retain(|m| m["hooks"].as_array().is_none_or(|hs| !hs.is_empty()));
    if *arr == before {
        return Ok(false);
    }
    let empty = arr.is_empty();
    if empty {
        if let Some(h) = doc.get_mut("hooks").and_then(Value::as_object_mut) {
            h.remove("SessionEnd");
            if h.is_empty() {
                doc.as_object_mut().map(|o| o.remove("hooks"));
            }
        }
    }
    write_json_doc(settings, &doc)?;
    Ok(true)
}

/// Is there a hook that runs `pama hook claude` in this settings file?
pub fn present_in(p: &Path) -> bool {
    let Ok(doc) = read_json_doc(p) else {
        return false;
    };
    doc["hooks"]["SessionEnd"].as_array().is_some_and(|arr| {
        arr.iter().any(|m| {
            m["hooks"]
                .as_array()
                .is_some_and(|hs| hs.iter().any(is_ours))
        })
    })
}

impl AgentAdapter for ClaudeAdapter {
    fn agent(&self) -> Agent {
        Agent::ClaudeCode
    }
    fn cli_id(&self) -> &'static str {
        "claude"
    }
    fn display_name(&self) -> &'static str {
        "Claude Code"
    }
    fn transcript_dirs(&self) -> Vec<PathBuf> {
        claude::projects_dir().into_iter().collect()
    }
    fn sessions(&self) -> Vec<FoundSession> {
        let mut files = Vec::new();
        for d in self.transcript_dirs() {
            jsonl_files(&d, 1, &mut files);
        }
        files
            .into_iter()
            .map(|f| FoundSession {
                session_id: f
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                updated: mtime(&f),
                location: f.to_string_lossy().into_owned(),
            })
            .collect()
    }
    fn parse(&self, location: &str) -> Result<NormalizedSession, ReadError> {
        claude::parse(Path::new(location))
    }
    fn hook_file(&self, scope: &HookScope) -> Option<PathBuf> {
        Some(match scope {
            HookScope::Global => home().join(".claude/settings.json"),
            HookScope::Project { dir, shared: true } => dir.join(".claude/settings.json"),
            HookScope::Project { dir, .. } => dir.join(".claude/settings.local.json"),
        })
    }
    fn install_hook(&self, scope: &HookScope, exe: &str) -> Result<Installed, HookError> {
        let f = self.hook_file(scope).expect("claude has every scope");
        Ok(if install_into(&f, &shell_command(exe, MARK))? {
            Installed::Added(f)
        } else {
            Installed::Unchanged(f)
        })
    }
    fn uninstall_hook(&self, scope: &HookScope) -> Result<bool, HookError> {
        uninstall_from(&self.hook_file(scope).expect("claude has every scope"))
    }
    fn hook_installed(&self, scope: &HookScope) -> bool {
        self.hook_file(scope).is_some_and(|f| present_in(&f))
    }
    fn idle_delay(&self, _session_end: bool) -> Duration {
        // Claude writes the transcript asynchronously; give it a moment before reading.
        Duration::from_secs(3)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_is_merged_once_keeps_other_settings_and_uninstalls_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join(".claude/settings.local.json");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(
            &f,
            r#"{"permissions":{"allow":["Bash(ls)"]},"hooks":{"Stop":[]}}"#,
        )
        .unwrap();
        assert!(install_into(&f, "/bin/pama hook claude").unwrap());
        assert!(
            !install_into(&f, "/bin/pama hook claude").unwrap(),
            "idempotent"
        );
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["permissions"]["allow"][0], "Bash(ls)");
        assert_eq!(
            v["hooks"]["SessionEnd"][0]["hooks"][0]["command"],
            "/bin/pama hook claude"
        );
        assert!(present_in(&f));
        assert!(uninstall_from(&f).unwrap());
        assert!(!uninstall_from(&f).unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert!(v["hooks"].get("SessionEnd").is_none());
        assert!(v["hooks"]["Stop"].is_array());
        assert_eq!(v["permissions"]["allow"][0], "Bash(ls)");
        assert!(!present_in(&f));
    }

    #[test]
    fn someone_elses_hook_with_a_similar_command_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("settings.json");
        std::fs::write(
            &f,
            r#"{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"~/bin/githook claude"},{"type":"command","command":"pama-notes hook claude --verbose"}]}]}}"#,
        )
        .unwrap();
        assert!(!present_in(&f));
        assert!(!uninstall_from(&f).unwrap());
        assert!(install_into(&f, "\"/Applications/pamA.app/bin/pama\" hook claude").unwrap());
        assert!(present_in(&f));
        assert!(uninstall_from(&f).unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        let hs = v["hooks"]["SessionEnd"][0]["hooks"].as_array().unwrap();
        assert_eq!(hs.len(), 2);
    }

    #[test]
    fn project_scopes_use_local_and_shared_files() {
        let a = ClaudeAdapter;
        let dir = PathBuf::from("/p");
        assert_eq!(
            a.hook_file(&HookScope::Project {
                dir: dir.clone(),
                shared: false
            }),
            Some(dir.join(".claude/settings.local.json"))
        );
        assert_eq!(
            a.hook_file(&HookScope::Project {
                dir: dir.clone(),
                shared: true
            }),
            Some(dir.join(".claude/settings.json"))
        );
    }
}
