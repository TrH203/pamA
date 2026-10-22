//! `pama hook claude|codex`: called by the agents when a session ends. Enqueue only, spawn a
//! detached drain, exit fast (Claude's SessionEnd hook has a 1.5 s budget, research R1).
//! A hook must never break the agent: failures are logged and the exit code stays 0.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

use pama_core::session::{claude, codex};
use pama_core::store::{Agent, NewCapture};
use serde_json::Value;

use super::Ctx;
use crate::{Exit, HookAgent};

/// Claude writes the transcript asynchronously; give it a moment before reading.
const CLAUDE_DELAY_MS: i64 = 3_000;
/// Codex `notify` fires after every turn: wait for the session to go idle.
const CODEX_IDLE_MS: i64 = 120_000;

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

pub fn run(ctx: &Ctx, agent: HookAgent) -> anyhow::Result<Exit> {
    let mut stdin = String::new();
    let raw = match &agent {
        HookAgent::Codex { json: Some(j) } => j.clone(),
        _ => {
            let _ = std::io::stdin().take(1 << 20).read_to_string(&mut stdin);
            stdin
        }
    };
    let input: Value = serde_json::from_str(raw.trim()).unwrap_or(Value::Null);
    let (capture, delay) = match agent {
        HookAgent::Claude => (claude_capture(&input), CLAUDE_DELAY_MS),
        HookAgent::Codex { .. } => {
            // Codex hooks (SessionEnd) mean the session is over; notify means a turn ended.
            let ended = str_of(&input, "hook_event_name").as_deref() == Some("SessionEnd");
            (codex_capture(&input), if ended { 0 } else { CODEX_IDLE_MS })
        }
    };
    match capture {
        Some(c) => match ctx.store.enqueue_capture(&c, delay) {
            Ok(_) => spawn_drain(),
            Err(e) => log(&format!("hook: enqueue failed: {e}")),
        },
        None => log("hook: input without a session id or transcript path"),
    }
    Ok(Exit::Ok)
}
