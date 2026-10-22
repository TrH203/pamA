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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub agent: Agent,
    pub session_id: String,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
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
            git_commit: None,
            repo_url: None,
            agent_version: None,
            started_at: None,
            ended_at: None,
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
