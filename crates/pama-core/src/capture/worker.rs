//! Capture worker: drives `captured_session` through
//! `detected → redacting → digesting → ready_for_review`, with retries and backoff in the store.

use std::fs::OpenOptions;
use std::path::Path;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use super::enabled_for;
use crate::digest::{Agent as DigestAgent, MAX_BRANCHES};
use crate::project;
use crate::redact::RuleSet;
use crate::session::{self, NormalizedSession};
use crate::store::{Agent, CaptureStatus, CapturedSession, Store};

/// Most events sent for one session (the server accepts up to 20,000).
const MAX_EVENTS: usize = 20_000;

#[derive(Debug)]
pub enum SinkError {
    /// Network, server down, model unavailable: retry later with backoff.
    Retryable(String),
    /// Rejected input: retrying will not help.
    Fatal(String),
}

/// Where redacted sessions go: the local server's `POST /v1/transcripts/digest`.
pub trait DigestSink {
    fn submit(&self, body: &Value) -> Result<Value, SinkError>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum CaptureOutcome {
    Submitted { digest_id: String, status: String },
    Skipped,
    Retry(String),
    Failed(String),
}

pub struct Worker<'a, S: DigestSink> {
    pub store: &'a Store,
    pub rules: &'a RuleSet,
    pub sink: S,
}

/// RFC 3339 UTC timestamp without external crates.
pub fn rfc3339(t: SystemTime) -> String {
    let secs = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

fn cap(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// Request body for the local server (contracts/http-api.md, device endpoints).
pub fn request_body(
    s: &NormalizedSession,
    counts: &crate::redact::Counts,
    fallback_session_id: &str,
) -> Value {
    let proj = project::resolve(s.meta.cwd.as_deref(), s.meta.repo_url.as_deref());
    let branch = s
        .meta
        .git_branch
        .clone()
        .or_else(|| s.meta.cwd.as_deref().and_then(project::current_branch));
    let start = s.events.len().saturating_sub(MAX_EVENTS);
    let events: Vec<Value> = s.events[start..]
        .iter()
        .map(|e| {
            let mut v = serde_json::to_value(e).expect("event json");
            v["text"] = json!(cap(&e.text, 20_000));
            if let Some(c) = &e.command {
                v["command"] = json!(cap(c, 4_000));
            }
            if let Some(p) = &e.path {
                v["path"] = json!(cap(p, 1_000));
            }
            if let Some(t) = &e.tool {
                v["tool"] = json!(cap(t, 64));
            }
            v
        })
        .collect();
    let agent = match s.meta.agent {
        DigestAgent::ClaudeCode => "claude_code",
        DigestAgent::Codex => "codex",
    };
    let sid = if s.meta.session_id.is_empty() {
        fallback_session_id
    } else {
        s.meta.session_id.as_str()
    };
    let mut body = json!({
        "agent": agent,
        "agent_session_id": cap(sid, 128),
        "project_key": proj.key,
        "project_name": cap(&proj.name, 200),
        "ended_at": s.meta.ended_at.clone().unwrap_or_else(|| rfc3339(SystemTime::now())),
        "events": events,
        "redactions": { "secret": counts.secret, "pii": counts.pii, "by_rule": counts.by_rule },
    });
    if let Some(b) = &branch {
        body["bundle_key"] = json!(cap(b, 256));
        body["git"] = json!({ "branch": cap(b, 256) });
    }
    if !s.meta.branches.is_empty() {
        let list: Vec<Value> = project::cap_branches(s.meta.branches.clone(), MAX_BRANCHES)
            .iter()
            .map(|b| {
                let mut v = json!({ "name": cap(&b.name, 256), "events": b.events });
                if let Some(t) = &b.first_seen {
                    v["first_seen"] = json!(t);
                }
                if let Some(t) = &b.last_seen {
                    v["last_seen"] = json!(t);
                }
                v
            })
            .collect();
        body["git"]["branches"] = json!(list);
    }
    if let Some(v) = &s.meta.agent_version {
        body["agent_version"] = json!(cap(v, 64));
    }
    if let Some(t) = &s.meta.started_at {
        body["started_at"] = json!(t);
    }
    body
}

impl<'a, S: DigestSink> Worker<'a, S> {
    pub fn process(&self, c: &CapturedSession) -> crate::store::Result<CaptureOutcome> {
        let st = self.store;
        st.set_capture_status(&c.id, CaptureStatus::Redacting)?;
        let path = Path::new(&c.transcript_path);
        let parsed = match c.agent {
            Agent::ClaudeCode => session::claude::parse(path),
            Agent::Codex => session::codex::parse(path),
        };
        let mut s = match parsed {
            Ok(s) => s,
            Err(e) => {
                let msg = e.to_string();
                // A missing file may still be being written; a too-large one never will fit.
                let retry = matches!(e, session::reader::ReadError::Io(..));
                return Ok(match st.fail_capture(&c.id, &msg, retry)? {
                    CaptureStatus::Failed => CaptureOutcome::Failed(msg),
                    _ => CaptureOutcome::Retry(msg),
                });
            }
        };
        if !enabled_for(st, s.meta.cwd.as_deref().or(c.cwd.as_deref())) {
            st.set_capture_status(&c.id, CaptureStatus::Skipped)?;
            return Ok(CaptureOutcome::Skipped);
        }
        let sha = session::reader::sha256_file(path).unwrap_or_default();
        st.set_capture_meta(
            &c.id,
            &sha,
            s.meta.repo_url.as_deref(),
            s.meta.git_branch.as_deref(),
        )?;
        let counts = session::redact_session(self.rules, &mut s);
        st.set_capture_status(&c.id, CaptureStatus::Digesting)?;
        let body = request_body(&s, &counts, &c.agent_session_id);
        match self.sink.submit(&body) {
            Ok(v) => {
                st.set_capture_status(&c.id, CaptureStatus::ReadyForReview)?;
                Ok(CaptureOutcome::Submitted {
                    digest_id: v["digest_id"].as_str().unwrap_or_default().to_string(),
                    status: v["status"].as_str().unwrap_or_default().to_string(),
                })
            }
            Err(SinkError::Retryable(m)) => Ok(match st.fail_capture(&c.id, &m, true)? {
                CaptureStatus::Failed => CaptureOutcome::Failed(m),
                _ => CaptureOutcome::Retry(m),
            }),
            Err(SinkError::Fatal(m)) => {
                st.fail_capture(&c.id, &m, false)?;
                Ok(CaptureOutcome::Failed(m))
            }
        }
    }

    /// Process every due capture once.
    pub fn run_due(&self) -> crate::store::Result<Vec<(String, CaptureOutcome)>> {
        let mut out = Vec::new();
        for c in self.store.due_captures(50)? {
            let o = self.process(&c)?;
            out.push((c.id.clone(), o));
        }
        Ok(out)
    }
}

/// Run the worker under a lock file so concurrent hook invocations do not race.
/// Returns `None` if another drain holds a fresh lock.
pub fn drain<S: DigestSink>(
    w: &Worker<'_, S>,
    lock: &Path,
) -> crate::store::Result<Option<Vec<(String, CaptureOutcome)>>> {
    if let Some(d) = lock.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let stale = std::fs::metadata(lock)
        .and_then(|m| m.modified())
        .map(|t| t.elapsed().unwrap_or_default() > Duration::from_secs(600))
        .unwrap_or(false);
    if stale {
        let _ = std::fs::remove_file(lock);
    }
    if OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock)
        .is_err()
    {
        return Ok(None);
    }
    let res = w.run_due();
    let _ = std::fs::remove_file(lock);
    res.map(Some)
}

#[cfg(test)]
mod tests {
    use super::rfc3339;
    use std::time::{Duration, SystemTime};

    #[test]
    fn formats_rfc3339() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_686_000);
        assert_eq!(rfc3339(t), "2026-10-22T16:20:00Z");
        assert_eq!(rfc3339(SystemTime::UNIX_EPOCH), "1970-01-01T00:00:00Z");
    }
}
