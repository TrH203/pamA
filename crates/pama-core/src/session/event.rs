//! Normalized transcript events: what every adapter produces and what Layer 1 and the digest
//! pipeline consume. Thinking/reasoning blocks are not kept.

use serde::{Deserialize, Serialize};

use crate::digest::Agent;

/// Longest tool result kept per event (head only); enough context for a digest.
pub const MAX_RESULT_CHARS: usize = 4_000;
/// Longest edit/write body kept per tool call.
pub const MAX_EDIT_CHARS: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    User,
    Assistant,
    ToolCall,
    ToolResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub kind: EventKind,
    pub text: String,
    /// Normalized tool name: `read`, `bash`, `edit`, `write`, `search`, or the agent's name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Links a tool result to its call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

impl Event {
    pub fn text(kind: EventKind, text: impl Into<String>, at: Option<String>) -> Self {
        Self {
            kind,
            text: text.into(),
            tool: None,
            path: None,
            command: None,
            call_id: None,
            at,
        }
    }
}

/// One branch a session worked on: first/last time seen and how many conversation records were
/// attributed to it. Kept in first-seen order, one entry per branch name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchVisit {
    pub name: String,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    pub events: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub agent: Agent,
    pub session_id: String,
    pub cwd: Option<String>,
    /// The branch the session is filed under (see `project::pick_filing_branch`).
    pub git_branch: Option<String>,
    /// Every branch visited, first-seen order.
    #[serde(default)]
    pub branches: Vec<BranchVisit>,
    pub git_commit: Option<String>,
    pub repo_url: Option<String>,
    pub agent_version: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

impl SessionMeta {
    pub fn new(agent: Agent, session_id: impl Into<String>) -> Self {
        Self {
            agent,
            session_id: session_id.into(),
            cwd: None,
            git_branch: None,
            branches: Vec::new(),
            git_commit: None,
            repo_url: None,
            agent_version: None,
            started_at: None,
            ended_at: None,
        }
    }

    /// Attribute one conversation record to `name` (dedupes by name, keeps first-seen order).
    pub fn observe_branch(&mut self, name: &str, at: Option<&str>) {
        let visit = match self.branches.iter().position(|b| b.name == name) {
            Some(i) => &mut self.branches[i],
            None => {
                self.branches.push(BranchVisit {
                    name: name.to_string(),
                    first_seen: at.map(String::from),
                    last_seen: at.map(String::from),
                    events: 0,
                });
                self.branches.last_mut().expect("just pushed")
            }
        };
        visit.events += 1;
        if let Some(t) = at {
            if visit.first_seen.as_deref().is_none_or(|f| t < f) {
                visit.first_seen = Some(t.to_string());
            }
            if visit.last_seen.as_deref().is_none_or(|l| t > l) {
                visit.last_seen = Some(t.to_string());
            }
        }
    }

    /// Order the branches by first sight and set `git_branch` to the filing branch.
    pub fn finish_branches(&mut self) {
        self.branches.sort_by(|a, b| {
            (a.first_seen.is_none(), &a.first_seen).cmp(&(b.first_seen.is_none(), &b.first_seen))
        });
        if let Some(name) = crate::project::pick_filing_branch(&self.branches) {
            self.git_branch = Some(name.to_string());
        }
    }

    /// Track the first and last timestamps seen.
    pub fn saw_time(&mut self, at: Option<&str>) {
        if let Some(t) = at {
            if self.started_at.as_deref().is_none_or(|s| t < s) {
                self.started_at = Some(t.to_string());
            }
            if self.ended_at.as_deref().is_none_or(|e| t > e) {
                self.ended_at = Some(t.to_string());
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NormalizedSession {
    pub meta: SessionMeta,
    pub events: Vec<Event>,
    /// Lines that were not valid JSON (tolerated, counted).
    pub skipped_lines: usize,
}

/// What a tool result needs from its call: normalized tool, path, command.
pub(crate) type CallInfo = (Option<String>, Option<String>, Option<String>);

pub(crate) fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}\n[…truncated]", &s[..i]),
        None => s.to_string(),
    }
}

/// Map an agent's tool name to the normalized name used by structural rules.
pub(crate) fn normalize_tool(name: &str) -> String {
    match name {
        "Read" | "read_file" | "NotebookRead" => "read".into(),
        "Bash" | "shell" | "exec_command" | "local_shell" | "BashOutput" => "bash".into(),
        "Edit" | "MultiEdit" | "NotebookEdit" => "edit".into(),
        "Write" => "write".into(),
        "Grep" | "Glob" | "LS" => "search".into(),
        other => other.to_ascii_lowercase(),
    }
}
