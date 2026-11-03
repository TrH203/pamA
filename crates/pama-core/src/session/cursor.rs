//! Cursor agent transcripts (spec 005 research): `~/.cursor/projects/<slug>/agent-transcripts/`
//! holds one JSONL file per conversation, either `<id>.jsonl` or `<id>/<id>.jsonl`. Rows are
//! `{"role": "user"|"assistant", "message": {"content": [blocks]}}` with `text` and `tool_use`
//! blocks. The format is undocumented and lossy (no tool results, few timestamps), so unknown
//! rows and fields are ignored. Hooks pass the exact path as `transcript_path`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::event::{truncate, CallInfo, Event, EventKind, NormalizedSession, SessionMeta};
use super::event::{MAX_EDIT_CHARS, MAX_RESULT_CHARS};
use super::reader::{for_each_json_line, ReadError};
use crate::digest::Agent;

/// `$CURSOR_HOME/projects` or `~/.cursor/projects`.
pub fn projects_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CURSOR_HOME") {
        return Some(PathBuf::from(dir).join("projects"));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join(".cursor/projects"))
}

/// Every transcript under a projects dir: `(session id, path)`. Subagent transcripts are skipped.
pub fn transcripts(projects: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(slugs) = std::fs::read_dir(projects) else {
        return out;
    };
    for slug in slugs.flatten() {
        let dir = slug.path().join("agent-transcripts");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                let id = e.file_name().to_string_lossy().into_owned();
                let f = p.join(format!("{id}.jsonl"));
                if f.is_file() {
                    out.push((id, f));
                }
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                let id = p
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                out.push((id, p));
            }
        }
    }
    out.sort_by(|a, b| a.1.cmp(&b.1));
    out
}

/// The workspace a project slug stands for. Cursor replaces `/` with `-`, so the slug is
/// ambiguous when directory names contain dashes: walk the filesystem and take the first path
/// that exists. `None` when nothing matches (the hook's `workspace_roots` is used instead).
pub fn workspace_of_slug(slug: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = slug.split('-').filter(|p| !p.is_empty()).collect();
    fn walk(base: &Path, parts: &[&str]) -> Option<PathBuf> {
        if parts.is_empty() {
            return Some(base.to_path_buf());
        }
        for take in 1..=parts.len() {
            let name = parts[..take].join("-");
            let cand = base.join(&name);
            if cand.is_dir() {
                if let Some(found) = walk(&cand, &parts[take..]) {
                    return Some(found);
                }
            }
        }
        None
    }
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    walk(Path::new(root), &parts).filter(|p| p != Path::new(root))
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// Cursor tool names vary by version (`run_terminal_cmd`, `Shell`, `read_file`, `StrReplace`…).
pub(crate) fn normalize_loose(name: &str) -> String {
    let n = name.to_ascii_lowercase();
    if n.contains("terminal") || n.contains("shell") || n == "bash" {
        "bash".into()
    } else if n.contains("replace") || n.contains("edit") || n.contains("patch") {
        "edit".into()
    } else if n.contains("write") || n.contains("create_file") {
        "write".into()
    } else if n.contains("read") {
        "read".into()
    } else if n.contains("grep") || n.contains("glob") || n.contains("search") || n.contains("list")
    {
        "search".into()
    } else {
        n
    }
}

pub(crate) fn tool_event(
    name: &str,
    input: &Value,
    id: Option<String>,
    at: Option<String>,
) -> Event {
    let tool = normalize_loose(name);
    let path = [
        "file_path",
        "filePath",
        "target_file",
        "path",
        "notebook_path",
    ]
    .iter()
    .find_map(|k| str_of(input, k))
    .map(String::from);
    let command = str_of(input, "command").map(String::from);
    let text = match tool.as_str() {
        "bash" => command.clone().unwrap_or_else(|| input.to_string()),
        "edit" | "write" => {
            let body = [
                "new_string",
                "newString",
                "content",
                "code_edit",
                "contents",
            ]
            .iter()
            .find_map(|k| str_of(input, k))
            .unwrap_or_default();
            format!(
                "{tool} {}\n{}",
                path.as_deref().unwrap_or("?"),
                truncate(body, MAX_EDIT_CHARS)
            )
        }
        _ => format!("{name} {}", truncate(&input.to_string(), MAX_EDIT_CHARS)),
    };
    Event {
        kind: EventKind::ToolCall,
        text,
        tool: Some(tool),
        path,
        command,
        call_id: id,
        at,
    }
}

fn session_id_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The project slug directory a transcript lives under (`…/projects/<slug>/agent-transcripts/…`).
fn slug_of(path: &Path) -> Option<String> {
    let mut it = path.ancestors();
    while let Some(a) = it.next() {
        if a.file_name().is_some_and(|n| n == "agent-transcripts") {
            return it
                .next()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned());
        }
    }
    None
}

pub fn parse(path: &Path) -> Result<NormalizedSession, ReadError> {
    let mut meta = SessionMeta::new(Agent::Cursor, session_id_of(path));
    let mut events = Vec::new();
    let mut calls: HashMap<String, CallInfo> = HashMap::new();
    let skipped = for_each_json_line(path, |r| {
        let role = str_of(&r, "role")
            .or_else(|| r.get("message").and_then(|m| str_of(m, "role")))
            .unwrap_or_default();
        let kind = match role {
            "user" => EventKind::User,
            "assistant" => EventKind::Assistant,
            _ => return,
        };
        let at = str_of(&r, "timestamp")
            .or_else(|| str_of(&r, "created_at"))
            .map(String::from);
        meta.saw_time(at.as_deref());
        if meta.cwd.is_none() {
            meta.cwd = str_of(&r, "cwd").map(String::from);
        }
        let content = r
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| r.get("content"));
        match content {
            Some(Value::String(s)) if !s.trim().is_empty() => {
                events.push(Event::text(kind, s.clone(), at))
            }
            Some(Value::Array(blocks)) => {
                for b in blocks {
                    match str_of(b, "type") {
                        Some("text") => {
                            if let Some(t) = str_of(b, "text").filter(|t| !t.trim().is_empty()) {
                                events.push(Event::text(kind, t, at.clone()));
                            }
                        }
                        Some("tool_use") => {
                            let ev = tool_event(
                                str_of(b, "name").unwrap_or("tool"),
                                b.get("input").unwrap_or(&Value::Null),
                                str_of(b, "id").map(String::from),
                                at.clone(),
                            );
                            if let Some(id) = &ev.call_id {
                                calls.insert(
                                    id.clone(),
                                    (ev.tool.clone(), ev.path.clone(), ev.command.clone()),
                                );
                            }
                            events.push(ev);
                        }
                        Some("tool_result") => {
                            let id = str_of(b, "tool_use_id").map(String::from);
                            let (tool, path, command) = id
                                .as_ref()
                                .and_then(|i| calls.get(i).cloned())
                                .unwrap_or_default();
                            let text = match b.get("content") {
                                Some(Value::String(s)) => s.clone(),
                                Some(v) => v.to_string(),
                                None => String::new(),
                            };
                            events.push(Event {
                                kind: EventKind::ToolResult,
                                text: truncate(&text, MAX_RESULT_CHARS),
                                tool,
                                path,
                                command,
                                call_id: id,
                                at: at.clone(),
                            });
                        }
                        _ => {} // thinking, images, unknown
                    }
                }
            }
            _ => {}
        }
    })?;
    if meta.cwd.is_none() {
        meta.cwd = slug_of(path)
            .and_then(|s| workspace_of_slug(&s))
            .map(|p| p.to_string_lossy().into_owned());
    }
    Ok(NormalizedSession {
        meta,
        events,
        skipped_lines: skipped,
    })
}
