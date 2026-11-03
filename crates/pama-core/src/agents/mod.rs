//! Agent adapters (spec 005): one [`AgentAdapter`] per coding agent pamA reads. An adapter knows
//! where the agent keeps its transcripts, how to parse one into the shared event model, and how
//! to install, remove and inspect the hook that tells pamA a session ended. Adding an agent means
//! one file here plus a parser in `session/` and fixtures.
//!
//! Hooks never break the agent: every installer merges into the agent's own config file, is
//! idempotent, and its uninstaller removes only what pamA added.

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod opencode;

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::digest::Agent;
use crate::session::reader::ReadError;
use crate::session::NormalizedSession;
use crate::store::Store;

/// Where a hook is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookScope {
    /// The user's own config (every project).
    Global,
    /// One project. `shared` means the committed config file (e.g. `.claude/settings.json`)
    /// rather than the personal one (`.claude/settings.local.json`).
    Project { dir: PathBuf, shared: bool },
}

impl HookScope {
    pub fn label(&self) -> String {
        match self {
            HookScope::Global => "global".into(),
            HookScope::Project { dir, shared } => format!(
                "project {}{}",
                dir.display(),
                if *shared { " (shared)" } else { "" }
            ),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HookError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Config(String),
}

/// What an install did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Installed {
    /// The hook was added to `file`.
    Added(PathBuf),
    /// Already present.
    Unchanged(PathBuf),
}

/// A hook found in one config file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HookFound {
    pub scope: String,
    pub file: PathBuf,
}

/// A session an adapter found on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundSession {
    pub session_id: String,
    /// The transcript path, or a location string the adapter understands (OpenCode database).
    pub location: String,
    pub updated: SystemTime,
}

pub trait AgentAdapter: Sync {
    fn agent(&self) -> Agent;
    /// Short CLI id (`claude`, `codex`, `cursor`, `opencode`).
    fn cli_id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    /// Where the agent keeps transcripts on this machine (may not exist).
    fn transcript_dirs(&self) -> Vec<PathBuf>;
    /// Sessions under the transcript dirs (used by `pama scan` and `pama agents`).
    fn sessions(&self) -> Vec<FoundSession>;
    /// Parse one session (path or location string from [`Self::sessions`] or a hook).
    fn parse(&self, location: &str) -> Result<NormalizedSession, ReadError>;
    /// Whether the agent can install at this scope (Codex has user scope only).
    fn supports_scope(&self, scope: &HookScope) -> bool {
        let _ = scope;
        true
    }
    /// The config file that holds the hook for `scope`.
    fn hook_file(&self, scope: &HookScope) -> Option<PathBuf>;
    fn install_hook(&self, scope: &HookScope, exe: &str) -> Result<Installed, HookError>;
    /// Remove pamA's hook. Returns whether anything changed.
    fn uninstall_hook(&self, scope: &HookScope) -> Result<bool, HookError>;
    /// Is pamA's hook present at `scope`?
    fn hook_installed(&self, scope: &HookScope) -> bool;
    /// How long to wait after a hook before reading the transcript. `session_end` is true when
    /// the hook says the session is over (vs. a turn ended, which repeats).
    fn idle_delay(&self, session_end: bool) -> Duration;
    /// Is the agent used on this machine (a transcript dir exists)?
    fn detected(&self) -> bool {
        self.transcript_dirs().iter().any(|d| d.exists())
    }
}

static CLAUDE: claude::ClaudeAdapter = claude::ClaudeAdapter;
static CODEX: codex::CodexAdapter = codex::CodexAdapter;
static CURSOR: cursor::CursorAdapter = cursor::CursorAdapter;
static OPENCODE: opencode::OpenCodeAdapter = opencode::OpenCodeAdapter;

/// Every adapter, in display order.
pub fn all() -> [&'static dyn AgentAdapter; 4] {
    [&CLAUDE, &CODEX, &CURSOR, &OPENCODE]
}

pub fn adapter(agent: Agent) -> &'static dyn AgentAdapter {
    match agent {
        Agent::ClaudeCode => &CLAUDE,
        Agent::Codex => &CODEX,
        Agent::Cursor => &CURSOR,
        Agent::OpenCode => &OPENCODE,
    }
}

/// Look up by CLI id or stored id (`claude`, `claude_code`, `opencode`…).
pub fn by_id(id: &str) -> Option<&'static dyn AgentAdapter> {
    Agent::from_id(id).map(adapter)
}

/// The shared agent list (`packages/types/agents.json`), also read by the server.
pub const AGENTS_JSON: &str = include_str!("../../../../packages/types/agents.json");

// --- per-agent enable flags --------------------------------------------------------------

fn enabled_key(agent: Agent) -> String {
    format!("agents.{}.enabled", agent.as_str())
}

/// Capture is on for an agent unless it was turned off (`pama agents disable`).
pub fn enabled(store: &Store, agent: Agent) -> bool {
    store.setting(&enabled_key(agent)).ok().flatten().as_deref() != Some("false")
}

pub fn set_enabled(store: &Store, agent: Agent, on: bool) -> crate::store::Result<()> {
    store.set_setting(&enabled_key(agent), if on { "true" } else { "false" })
}

/// Every hook scope worth checking: global plus each captured project, personal and shared.
pub fn scopes_to_check(store: &Store) -> Vec<HookScope> {
    let mut v = vec![HookScope::Global];
    for p in crate::capture::enabled_projects(store) {
        for shared in [false, true] {
            v.push(HookScope::Project {
                dir: PathBuf::from(&p),
                shared,
            });
        }
    }
    v
}

/// Where pamA's hook for this adapter is installed (global and per captured project).
pub fn hook_locations(store: &Store, a: &dyn AgentAdapter) -> Vec<HookFound> {
    let mut out: Vec<HookFound> = Vec::new();
    for s in scopes_to_check(store) {
        if !a.supports_scope(&s) || !a.hook_installed(&s) {
            continue;
        }
        if let Some(file) = a.hook_file(&s) {
            if out.iter().all(|f| f.file != file) {
                out.push(HookFound {
                    scope: s.label(),
                    file,
                });
            }
        }
    }
    out
}

// --- small helpers shared by the adapters --------------------------------------------------

pub(crate) fn home() -> PathBuf {
    crate::paths::home_dir()
}

pub(crate) fn mtime(p: &Path) -> SystemTime {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

pub(crate) fn jsonl_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            // Claude subagent transcripts are merged into their parent session.
            if depth > 0 && p.file_name().is_none_or(|n| n != "subagents") {
                jsonl_files(&p, depth - 1, out);
            }
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            out.push(p);
        }
    }
}

/// Read a JSON config file (missing or empty → `{}`).
pub(crate) fn read_json_doc(file: &Path) -> Result<serde_json::Value, HookError> {
    match std::fs::read_to_string(file) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s)
            .map_err(|e| HookError::Config(format!("{} is not valid JSON: {e}", file.display()))),
        _ => Ok(serde_json::json!({})),
    }
}

pub(crate) fn write_json_doc(file: &Path, doc: &serde_json::Value) -> Result<(), HookError> {
    if let Some(d) = file.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(
        file,
        serde_json::to_string_pretty(doc).expect("json") + "\n",
    )?;
    Ok(())
}

/// A matcher for the hook command pamA writes: `<exe> <mark>` (the exe possibly quoted), where
/// the executable's file name is `pama` (`pama.exe`). Commands of other tools that merely contain
/// the words (`githook claude`) are never treated as pamA's, so uninstall leaves them alone.
pub(crate) fn is_pama_command(mark: &'static str) -> impl Fn(&str) -> bool {
    move |cmd: &str| {
        let Some(exe) = cmd.trim().strip_suffix(mark) else {
            return false;
        };
        let exe = exe.trim_end();
        if exe.len() == cmd.trim().len() - mark.len() {
            // No separator between the executable and the mark.
            return false;
        }
        let exe = exe.trim_matches('"');
        let name = exe
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        name == "pama" || name == "pama.exe"
    }
}

/// Quote the executable for a shell command line.
pub fn shell_command(exe: &str, args: &str) -> String {
    if exe.contains(' ') {
        format!("\"{exe}\" {args}")
    } else {
        format!("{exe} {args}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_matches_the_shared_agent_list() {
        let v: serde_json::Value = serde_json::from_str(AGENTS_JSON).unwrap();
        let ids: Vec<&str> = v["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["id"].as_str().unwrap())
            .collect();
        let ours: Vec<&str> = all().iter().map(|a| a.agent().as_str()).collect();
        assert_eq!(ids, ours);
        for (a, j) in all().iter().zip(v["agents"].as_array().unwrap()) {
            assert_eq!(a.display_name(), j["display_name"].as_str().unwrap());
            assert_eq!(a.cli_id(), j["cli_id"].as_str().unwrap());
            assert_eq!(by_id(a.cli_id()).unwrap().agent(), a.agent());
        }
        assert_eq!(
            Agent::ALL.iter().map(|a| a.as_str()).collect::<Vec<_>>(),
            ours
        );
    }

    #[test]
    fn pama_commands_are_recognised_by_executable_name() {
        let m = is_pama_command("hook claude");
        assert!(m("/usr/local/bin/pama hook claude"));
        assert!(m("pama hook claude"));
        assert!(m("\"/Applications/pamA app/pama\" hook claude"));
        assert!(m("C:\\Tools\\pama.exe hook claude"));
        assert!(!m("~/bin/githook claude"));
        assert!(!m("pama-notes hook claude"));
        assert!(!m("pamahook claude"));
        assert!(!m("/bin/pama hook claude --x"));
    }

    #[test]
    fn enable_flags_default_on() {
        let s = Store::open_in_memory().unwrap();
        assert!(enabled(&s, Agent::Cursor));
        set_enabled(&s, Agent::Cursor, false).unwrap();
        assert!(!enabled(&s, Agent::Cursor));
        assert!(enabled(&s, Agent::Codex));
    }
}
