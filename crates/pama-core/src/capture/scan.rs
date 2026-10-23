//! Watcher fallback (research R1/R2): find ended sessions that hooks did not report.
//! A transcript counts as ended when it has not changed for `idle`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::session::{claude, codex};
use crate::store::{Agent, NewCapture, Store};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ScanReport {
    pub seen: usize,
    pub enqueued: usize,
}

fn jsonl_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
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

fn modified_within(p: &Path, since: Duration, idle: Duration) -> bool {
    let Ok(m) = std::fs::metadata(p).and_then(|m| m.modified()) else {
        return false;
    };
    let age = SystemTime::now().duration_since(m).unwrap_or_default();
    age <= since && age >= idle
}

/// `rollout-<ts>-<uuid>.jsonl` → `<uuid>` (last five dash-separated groups).
pub fn codex_session_id(file: &Path) -> String {
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() >= 5 {
        parts[parts.len() - 5..].join("-")
    } else {
        stem
    }
}

pub fn scan(
    store: &Store,
    claude_projects: Option<&Path>,
    codex_sessions: Option<&Path>,
    since: Duration,
    idle: Duration,
) -> crate::store::Result<ScanReport> {
    let mut report = ScanReport::default();
    let known: std::collections::HashSet<(String, String)> = store
        .captures(100_000)?
        .into_iter()
        .map(|c| (c.agent.as_str().to_string(), c.agent_session_id))
        .collect();
    let mut found: Vec<(Agent, String, PathBuf)> = Vec::new();
    if let Some(dir) = claude_projects {
        let mut files = Vec::new();
        jsonl_files(dir, 1, &mut files);
        for f in files {
            let id = f
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            found.push((Agent::ClaudeCode, id, f));
        }
    }
    if let Some(dir) = codex_sessions {
        let mut files = Vec::new();
        jsonl_files(dir, 3, &mut files);
        for f in files {
            found.push((Agent::Codex, codex_session_id(&f), f));
        }
    }
    for (agent, id, path) in found {
        if !modified_within(&path, since, idle) {
            continue;
        }
        report.seen += 1;
        if known.contains(&(agent.as_str().to_string(), id.clone())) {
            continue;
        }
        store.enqueue_capture(
            &NewCapture {
                agent,
                agent_session_id: id,
                transcript_path: path.to_string_lossy().into_owned(),
                cwd: None,
                reason: Some("scan".into()),
            },
            0,
        )?;
        report.enqueued += 1;
    }
    Ok(report)
}

/// Default agent locations on this machine.
pub fn default_dirs() -> (Option<PathBuf>, Option<PathBuf>) {
    (claude::projects_dir(), codex::sessions_dir())
}
