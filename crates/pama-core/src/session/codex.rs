//! Codex CLI rollouts (research R2): `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`,
//! envelope `{timestamp, type, payload}`. Only `response_item` messages and tool calls are used;
//! `event_msg` duplicates and encrypted reasoning are skipped.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::event::{
    normalize_tool, truncate, CallInfo, Event, EventKind, NormalizedSession, SessionMeta,
    MAX_EDIT_CHARS, MAX_RESULT_CHARS,
};
use super::reader::{for_each_json_line, ReadError};
use crate::digest::Agent;

pub fn sessions_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME") {
        return Some(PathBuf::from(dir).join("sessions"));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join(".codex/sessions"))
}

/// Injected context blocks that are not part of the conversation.
const INJECTED: [&str; 3] = [
    "<environment_context>",
    "<user_instructions>",
    "# AGENTS.md",
];

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// `["bash", "-lc", "cmd"]` → `cmd`; other argv arrays are joined with spaces.
fn command_of(args: &Value) -> Option<String> {
    if let Some(s) = str_of(args, "cmd").or_else(|| str_of(args, "command")) {
        return Some(s.to_string());
    }
    let argv: Vec<&str> = args
        .get("command")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    match argv.as_slice() {
        [sh, flag, cmd] if sh.ends_with("sh") && flag.starts_with('-') && flag.contains('c') => {
            Some((*cmd).to_string())
        }
        _ => Some(argv.join(" ")),
    }
}

/// Function outputs are a string, a JSON envelope `{"output": "...", "metadata": {...}}`, or
/// (code mode, 0.14x) a list of `{type: "text", text}` parts.
fn output_text(raw: &Value) -> String {
    if let Value::Array(parts) = raw {
        return parts
            .iter()
            .filter_map(|p| str_of(p, "text"))
            .collect::<Vec<_>>()
            .join("\n");
    }
    let s = match raw {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    match serde_json::from_str::<Value>(&s) {
        Ok(v) => str_of(&v, "output").map(String::from).unwrap_or(s),
        Err(_) => s,
    }
}

pub fn parse(path: &Path) -> Result<NormalizedSession, ReadError> {
    let mut meta = SessionMeta::new(Agent::Codex, String::new());
    let mut events = Vec::new();
    let mut calls: HashMap<String, CallInfo> = HashMap::new();

    let skipped = for_each_json_line(path, |r| {
        let at = str_of(&r, "timestamp").map(String::from);
        let Some(p) = r.get("payload") else { return };
        match str_of(&r, "type") {
            Some("session_meta") => {
                meta.session_id = str_of(p, "id").unwrap_or_default().to_string();
                meta.cwd = str_of(p, "cwd").map(String::from);
                meta.agent_version = str_of(p, "cli_version").map(String::from);
                if let Some(g) = p.get("git") {
                    meta.git_branch = str_of(g, "branch").map(String::from);
                    meta.git_commit = str_of(g, "commit_hash").map(String::from);
                    meta.repo_url = str_of(g, "repository_url").map(String::from);
                }
                meta.saw_time(at.as_deref());
            }
            Some("response_item") => {
                meta.saw_time(at.as_deref());
                match str_of(p, "type") {
                    Some("message") => {
                        let kind = if str_of(p, "role") == Some("user") {
                            EventKind::User
                        } else {
                            EventKind::Assistant
                        };
                        let text: String = p
                            .get("content")
                            .and_then(Value::as_array)
                            .map(|parts| {
                                parts
                                    .iter()
                                    .filter_map(|x| str_of(x, "text"))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        let t = text.trim_start();
                        if text.is_empty() || INJECTED.iter().any(|m| t.starts_with(m)) {
                            return;
                        }
                        if str_of(p, "role") == Some("system")
                            || str_of(p, "role") == Some("developer")
                        {
                            return;
                        }
                        events.push(Event::text(kind, text, at));
                    }
                    Some("function_call") | Some("custom_tool_call") | Some("local_shell_call") => {
                        let name = str_of(p, "name").unwrap_or("shell");
                        let args: Value = match p.get("arguments") {
                            Some(Value::String(s)) => {
                                serde_json::from_str(s).unwrap_or(Value::Null)
                            }
                            Some(v) => v.clone(),
                            None => p.get("action").cloned().unwrap_or(Value::Null),
                        };
                        let tool = normalize_tool(name);
                        let command = match tool.as_str() {
                            "bash" => command_of(&args),
                            // Code-mode cells: the code is what runs, so structural rules see it.
                            "exec" => str_of(p, "input").map(|i| truncate(i, MAX_EDIT_CHARS)),
                            _ => None,
                        };
                        let path = str_of(&args, "path").map(String::from);
                        let text = match (&command, str_of(p, "input")) {
                            (Some(c), _) => c.clone(),
                            (None, Some(input)) => {
                                format!("{name}\n{}", truncate(input, MAX_EDIT_CHARS))
                            }
                            (None, None) => {
                                format!("{name} {}", truncate(&args.to_string(), MAX_EDIT_CHARS))
                            }
                        };
                        let call_id = str_of(p, "call_id").map(String::from);
                        if let Some(id) = &call_id {
                            calls.insert(
                                id.clone(),
                                (Some(tool.clone()), path.clone(), command.clone()),
                            );
                        }
                        events.push(Event {
                            kind: EventKind::ToolCall,
                            text,
                            tool: Some(tool),
                            path,
                            command,
                            call_id,
                            at,
                        });
                    }
                    Some("function_call_output") | Some("custom_tool_call_output") => {
                        let call_id = str_of(p, "call_id").map(String::from);
                        let (tool, path, command) = call_id
                            .as_ref()
                            .and_then(|i| calls.get(i).cloned())
                            .unwrap_or_default();
                        let text = truncate(
                            &output_text(p.get("output").unwrap_or(&Value::Null)),
                            MAX_RESULT_CHARS,
                        );
                        events.push(Event {
                            kind: EventKind::ToolResult,
                            text,
                            tool,
                            path,
                            command,
                            call_id,
                            at,
                        });
                    }
                    _ => {} // reasoning (encrypted), unknown
                }
            }
            _ => {} // turn_context, event_msg duplicates, compacted, …
        }
    })?;

    if meta.session_id.is_empty() {
        // Fall back to the uuid at the end of the file name.
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        meta.session_id = stem
            .rsplitn(6, '-')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("-");
    }
    Ok(NormalizedSession {
        meta,
        events,
        skipped_lines: skipped,
    })
}
