//! Claude Code transcripts (research R1): `~/.claude/projects/<cwd with "/"→"-">/<id>.jsonl`,
//! subagents under `<id>/subagents/agent-*.jsonl`. The format is undocumented, so unknown record
//! types and fields are ignored.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::event::{
    normalize_tool, truncate, CallInfo, Event, EventKind, NormalizedSession, SessionMeta,
    MAX_EDIT_CHARS, MAX_RESULT_CHARS,
};
use super::reader::{for_each_json_line, ReadError};
use crate::digest::Agent;

/// `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`.
pub fn projects_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("projects"));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join(".claude/projects"))
}

/// Project directory name used by Claude Code: every non-alphanumeric character becomes `-`.
pub fn project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub fn transcript_path(projects: &Path, cwd: &str, session_id: &str) -> PathBuf {
    projects
        .join(project_dir_name(cwd))
        .join(format!("{session_id}.jsonl"))
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| {
                (str_of(p, "type") == Some("text"))
                    .then(|| str_of(p, "text"))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn tool_call(name: &str, input: &Value, id: Option<&str>, at: Option<String>) -> Event {
    let tool = normalize_tool(name);
    let path = str_of(input, "file_path")
        .or_else(|| str_of(input, "notebook_path"))
        .or_else(|| str_of(input, "path"))
        .map(String::from);
    let command = str_of(input, "command").map(String::from);
    let text = match tool.as_str() {
        "bash" => command.clone().unwrap_or_default(),
        "edit" => {
            let new = str_of(input, "new_string").unwrap_or_default();
            format!(
                "edit {}\n{}",
                path.as_deref().unwrap_or("?"),
                truncate(new, MAX_EDIT_CHARS)
            )
        }
        "write" => {
            let body = str_of(input, "content").unwrap_or_default();
            format!(
                "write {}\n{}",
                path.as_deref().unwrap_or("?"),
                truncate(body, MAX_EDIT_CHARS)
            )
        }
        _ => {
            let s = input.to_string();
            format!("{name} {}", truncate(&s, MAX_EDIT_CHARS))
        }
    };
    Event {
        kind: EventKind::ToolCall,
        text,
        tool: Some(tool),
        path,
        command,
        call_id: id.map(String::from),
        at,
    }
}

struct Parser {
    meta: SessionMeta,
    current_branch: Option<String>,
    events: Vec<Event>,
    calls: HashMap<String, CallInfo>,
}

impl Parser {
    fn record(&mut self, r: Value) {
        let kind = str_of(&r, "type").unwrap_or_default();
        if kind != "user" && kind != "assistant" {
            return; // summaries, snapshots, api-request blobs, titles, future types…
        }
        if r.get("isMeta").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let at = str_of(&r, "timestamp").map(String::from);
        self.meta.saw_time(at.as_deref());
        if self.meta.cwd.is_none() {
            self.meta.cwd = str_of(&r, "cwd").map(String::from);
        }
        // Records without `gitBranch` continue on the branch seen last.
        if let Some(b) = str_of(&r, "gitBranch").filter(|b| !b.is_empty()) {
            self.current_branch = Some(b.to_string());
        }
        if let Some(b) = self.current_branch.clone() {
            self.meta.observe_branch(&b, at.as_deref());
        }
        if self.meta.agent_version.is_none() {
            self.meta.agent_version = str_of(&r, "version").map(String::from);
        }
        let Some(msg) = r.get("message") else { return };
        let ev_kind = if kind == "user" {
            EventKind::User
        } else {
            EventKind::Assistant
        };
        match msg.get("content") {
            Some(Value::String(s)) => self.events.push(Event::text(ev_kind, s.clone(), at)),
            Some(Value::Array(blocks)) => {
                for b in blocks {
                    self.block(ev_kind, b, at.clone());
                }
            }
            _ => {}
        }
    }

    fn block(&mut self, ev_kind: EventKind, b: &Value, at: Option<String>) {
        match str_of(b, "type") {
            Some("text") => {
                if let Some(t) = str_of(b, "text") {
                    self.events.push(Event::text(ev_kind, t, at));
                }
            }
            Some("tool_use") => {
                let name = str_of(b, "name").unwrap_or("tool");
                let ev = tool_call(
                    name,
                    b.get("input").unwrap_or(&Value::Null),
                    str_of(b, "id"),
                    at,
                );
                if let Some(id) = &ev.call_id {
                    self.calls.insert(
                        id.clone(),
                        (ev.tool.clone(), ev.path.clone(), ev.command.clone()),
                    );
                }
                self.events.push(ev);
            }
            Some("tool_result") => {
                let id = str_of(b, "tool_use_id").map(String::from);
                let (tool, path, command) = id
                    .as_ref()
                    .and_then(|i| self.calls.get(i).cloned())
                    .unwrap_or_default();
                let text = truncate(
                    &result_text(b.get("content").unwrap_or(&Value::Null)),
                    MAX_RESULT_CHARS,
                );
                self.events.push(Event {
                    kind: EventKind::ToolResult,
                    text,
                    tool,
                    path,
                    command,
                    call_id: id,
                    at,
                });
            }
            _ => {} // thinking, images, unknown blocks
        }
    }
}

/// Parse a session transcript and merge its subagent transcripts (if any).
pub fn parse(path: &Path) -> Result<NormalizedSession, ReadError> {
    let session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut p = Parser {
        meta: SessionMeta::new(Agent::ClaudeCode, session_id.clone()),
        current_branch: None,
        events: Vec::new(),
        calls: HashMap::new(),
    };
    let mut skipped = for_each_json_line(path, |r| p.record(r))?;

    let sub = path.with_extension("").join("subagents");
    if let Ok(entries) = std::fs::read_dir(&sub) {
        let mut files: Vec<_> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|f| f.extension().is_some_and(|x| x == "jsonl"))
            .collect();
        files.sort();
        for f in files {
            skipped += for_each_json_line(&f, |r| p.record(r))?;
        }
    }
    p.events.sort_by(|a, b| a.at.cmp(&b.at));
    p.meta.finish_branches();
    Ok(NormalizedSession {
        meta: p.meta,
        events: p.events,
        skipped_lines: skipped,
    })
}
