//! `pama hook claude|codex|cursor|opencode`: called by the agents when a session ends. Enqueue only, spawn a
//! detached drain, exit fast (Claude's SessionEnd hook has a 1.5 s budget, research R1).
//! A hook must never break the agent: failures are logged and the exit code stays 0.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

use pama_core::agents::{self, AgentAdapter};
use pama_core::session::{claude, codex, opencode};
use pama_core::store::{Agent, NewCapture};
use serde_json::Value;

use super::Ctx;
use crate::{Exit, HookAgent};

pub fn log(msg: &str) {
    use std::io::Write;
    let path = pama_core::paths::log_file();
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(
            f,
            "{} {msg}",
            pama_core::capture::worker::rfc3339(SystemTime::now())
        );
    }
}

/// Start `pama capture drain` in the background, detached from the agent's process.
pub fn spawn_drain() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut cmd = Command::new(exe);
    cmd.args(["capture", "drain"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    if let Err(e) = cmd.spawn() {
        log(&format!("hook: cannot spawn drain: {e}"));
    }
}

fn str_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(String::from)
}

fn claude_capture(input: &Value) -> Option<NewCapture> {
    let session_id = str_of(input, "session_id")?;
    let cwd = str_of(input, "cwd");
    let path = str_of(input, "transcript_path").or_else(|| {
        let projects = claude::projects_dir()?;
        Some(
            claude::transcript_path(&projects, cwd.as_deref()?, &session_id)
                .to_string_lossy()
                .into_owned(),
        )
    })?;
    Some(NewCapture {
        agent: Agent::ClaudeCode,
        agent_session_id: session_id,
        transcript_path: path,
        cwd,
        reason: str_of(input, "reason").or_else(|| str_of(input, "hook_event_name")),
    })
}

fn newest_rollout(dir: &Path, id_hint: Option<&str>) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let mut stack = vec![(dir.to_path_buf(), 0)];
    while let Some((d, depth)) = stack.pop() {
        for e in std::fs::read_dir(&d).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() && depth < 3 {
                stack.push((p, depth + 1));
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                if let Some(id) = id_hint {
                    if p.to_string_lossy().contains(id) {
                        return Some(p);
                    }
                }
                let m = e.metadata().and_then(|m| m.modified()).ok()?;
                if best.as_ref().is_none_or(|(t, _)| m > *t) {
                    best = Some((m, p));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

fn codex_capture(input: &Value) -> Option<NewCapture> {
    let dir = codex::sessions_dir()?;
    let hint = str_of(input, "session_id")
        .or_else(|| str_of(input, "thread-id"))
        .or_else(|| str_of(input, "thread_id"));
    let path = str_of(input, "transcript_path")
        .map(PathBuf::from)
        .or_else(|| newest_rollout(&dir, hint.as_deref()))?;
    Some(NewCapture {
        agent: Agent::Codex,
        agent_session_id: pama_core::capture::scan::codex_session_id(&path),
        transcript_path: path.to_string_lossy().into_owned(),
        cwd: str_of(input, "cwd"),
        reason: str_of(input, "type").or_else(|| str_of(input, "hook_event_name")),
    })
}

/// Cursor hooks: `transcript_path`, `conversation_id` and `workspace_roots` on stdin.
fn cursor_capture(input: &Value) -> Option<NewCapture> {
    let path = str_of(input, "transcript_path").filter(|p| !p.is_empty())?;
    let id = str_of(input, "conversation_id")
        .or_else(|| str_of(input, "session_id"))
        .unwrap_or_else(|| {
            Path::new(&path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    let cwd = input["workspace_roots"]
        .as_array()
        .and_then(|r| r.first())
        .and_then(Value::as_str)
        .map(String::from);
    Some(NewCapture {
        agent: Agent::Cursor,
        agent_session_id: id,
        transcript_path: path,
        cwd,
        reason: str_of(input, "hook_event_name"),
    })
}

/// OpenCode plugin: `{session_id, cwd}`; the session is read from OpenCode's own storage.
fn opencode_capture(input: &Value) -> Option<NewCapture> {
    let id = str_of(input, "session_id")?;
    let location = opencode::locate(&opencode::data_dir()?, &id)?;
    Some(NewCapture {
        agent: Agent::OpenCode,
        agent_session_id: id,
        transcript_path: location,
        cwd: str_of(input, "cwd"),
        reason: str_of(input, "hook_event_name"),
    })
}

/// Run the notifier pamA chained in front of (Codex `notify`), detached, with the same JSON.
fn run_chained(argv: &[String], json: Option<&str>) {
    let Some((prog, args)) = argv.split_first() else {
        return;
    };
    let mut cmd = Command::new(prog);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(j) = json {
        cmd.arg(j);
    }
    if let Err(e) = cmd.spawn() {
        log(&format!("hook: chained notifier {prog} failed: {e}"));
    }
}

fn delay_ms(a: &dyn AgentAdapter, session_end: bool) -> i64 {
    a.idle_delay(session_end).as_millis() as i64
}

pub fn run(ctx: &Ctx, agent: HookAgent) -> anyhow::Result<Exit> {
    let mut stdin = String::new();
    let mut read_stdin = || {
        let _ = std::io::stdin().take(1 << 20).read_to_string(&mut stdin);
        stdin.clone()
    };
    let (raw, chained) = match &agent {
        HookAgent::Codex { args } => {
            let (chain, json) = agents::codex::split_hook_args(args);
            (json.unwrap_or_else(&mut read_stdin), chain)
        }
        HookAgent::Opencode { json: Some(j) } => (j.clone(), Vec::new()),
        _ => (read_stdin(), Vec::new()),
    };
    if !chained.is_empty() {
        run_chained(&chained, Some(raw.trim()).filter(|j| !j.is_empty()));
    }
    let input: Value = serde_json::from_str(raw.trim()).unwrap_or(Value::Null);
    let event = str_of(&input, "hook_event_name");
    let (kind, capture, delay) = match agent {
        HookAgent::Claude => {
            let a = agents::adapter(Agent::ClaudeCode);
            (Agent::ClaudeCode, claude_capture(&input), delay_ms(a, true))
        }
        HookAgent::Codex { .. } => {
            // Codex hooks (SessionEnd) mean the session is over; notify means a turn ended.
            let ended = event.as_deref() == Some("SessionEnd");
            let a = agents::adapter(Agent::Codex);
            (Agent::Codex, codex_capture(&input), delay_ms(a, ended))
        }
        HookAgent::Cursor => {
            // `stop` ends one agent loop (repeats per turn); `sessionEnd` closes the chat.
            let ended = event.as_deref() == Some("sessionEnd");
            let a = agents::adapter(Agent::Cursor);
            (Agent::Cursor, cursor_capture(&input), delay_ms(a, ended))
        }
        HookAgent::Opencode { .. } => {
            let a = agents::adapter(Agent::OpenCode);
            (
                Agent::OpenCode,
                opencode_capture(&input),
                delay_ms(a, false),
            )
        }
    };
    if !agents::enabled(&ctx.store, kind) {
        return Ok(Exit::Ok);
    }
    match capture {
        Some(c) => match ctx.store.enqueue_capture(&c, delay) {
            Ok(_) => spawn_drain(),
            Err(e) => log(&format!("hook: enqueue failed: {e}")),
        },
        None => log(&format!(
            "hook {}: input without a session id or transcript path",
            kind.as_str()
        )),
    }
    Ok(Exit::Ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cursor_hook_input_becomes_a_capture() {
        let c = cursor_capture(&json!({
            "conversation_id": "conv-1",
            "hook_event_name": "stop",
            "transcript_path": "/h/.cursor/projects/x/agent-transcripts/conv-1.jsonl",
            "workspace_roots": ["/work/shop"],
        }))
        .unwrap();
        assert_eq!(c.agent, Agent::Cursor);
        assert_eq!(c.agent_session_id, "conv-1");
        assert_eq!(c.cwd.as_deref(), Some("/work/shop"));
        // Transcripts disabled in Cursor: nothing to read, the scan cannot help either.
        assert!(
            cursor_capture(&json!({ "conversation_id": "c", "transcript_path": null })).is_none()
        );
    }
}
