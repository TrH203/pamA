//! Capture worker: drives `captured_session` through
//! `detected → redacting → digesting → ready_for_review → submitted`, with coded errors, the
//! retry schedule in the store, and one `capture_attempt` row per try (spec 006).

use std::fs::OpenOptions;
use std::path::Path;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use super::enabled_for;
use super::errors::{CodedError, ErrorCode, Policy};
use crate::digest::MAX_BRANCHES;
use crate::project;
use crate::redact::RuleSet;
use crate::session::{self, NormalizedSession};
use crate::store::{CaptureStatus, CapturedSession, Store};

/// Most events sent for one session (the server accepts up to 20,000).
const MAX_EVENTS: usize = 20_000;

/// A sink failure with its code; the code decides retry, wait-for-user, give-up or skip
/// ([`ErrorCode::policy`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SinkError(pub Box<CodedError>);

impl SinkError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self(Box::new(CodedError::new(code, message)))
    }
}

impl From<CodedError> for SinkError {
    fn from(e: CodedError) -> Self {
        Self(Box::new(e))
    }
}

/// Where redacted sessions go: the local server's `POST /v1/transcripts/digest`, or in remote
/// mode the on-device drafter (`remote::RemoteSink`).
pub trait DigestSink {
    fn submit(&self, body: &Value) -> Result<Value, SinkError>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum CaptureOutcome {
    /// `digest_id` is the server's id, or empty while the draft is queued on the device.
    Submitted {
        digest_id: String,
        status: String,
    },
    Skipped(ErrorCode),
    Retry(CodedError),
    Failed(CodedError),
}

/// Fewest characters of conversation (user and assistant text plus what tool calls did) worth a
/// digest.
pub const MIN_CONVERSATION_CHARS: usize = 40;

/// Empty or trivial session guard (spec 006 FR-006): a session is worth a digest when the user
/// wrote something, the agent answered it (assistant text) or acted on it (a tool call), and
/// there are at least [`MIN_CONVERSATION_CHARS`] characters of conversation. A tool call counts
/// with its command, path or input text, so "fix it" followed by edits is real work, while a
/// greeting and a one-line reply is not. Tool results are output, not conversation, and do not
/// count. Trivial sessions are skipped with `empty_session` before any model call.
pub fn is_trivial(s: &NormalizedSession) -> bool {
    use crate::session::EventKind;
    let (mut user, mut agent, mut chars) = (false, false, 0usize);
    for e in &s.events {
        let n = match e.kind {
            EventKind::User | EventKind::Assistant => e.text.trim().chars().count(),
            EventKind::ToolCall => [
                e.command.as_deref(),
                e.path.as_deref(),
                Some(e.text.as_str()),
            ]
            .into_iter()
            .flatten()
            .map(|t| t.trim().chars().count())
            .max()
            .unwrap_or(0)
            .max(usize::from(e.tool.is_some())),
            EventKind::ToolResult => 0,
        };
        if n == 0 {
            continue;
        }
        match e.kind {
            EventKind::User => user = true,
            EventKind::Assistant | EventKind::ToolCall => agent = true,
            EventKind::ToolResult => {}
        }
        chars += n;
    }
    !(user && agent && chars >= MIN_CONVERSATION_CHARS)
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
    let agent = s.meta.agent.as_str();
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
        let attempt = st.start_attempt(&c.id)?;
        let out = self.run_attempt(c, &attempt);
        match &out {
            Ok(CaptureOutcome::Submitted { digest_id, status }) => {
                let (outcome, d) = if status == "queued" {
                    ("queued", None)
                } else {
                    ("succeeded", Some(digest_id.as_str()))
                };
                st.finish_attempt(&attempt, outcome, None, d, None)?;
            }
            Ok(CaptureOutcome::Skipped(code)) => {
                let e = CodedError::new(*code, code.hint());
                st.finish_attempt(&attempt, "skipped", Some(&e), None, None)?;
            }
            Ok(CaptureOutcome::Retry(e)) => {
                st.finish_attempt(&attempt, "retry", Some(e), None, None)?
            }
            Ok(CaptureOutcome::Failed(e)) => {
                st.finish_attempt(&attempt, "failed", Some(e), None, None)?
            }
            Err(e) => {
                let ce = CodedError::new(ErrorCode::Internal, e.to_string());
                let _ = st.finish_attempt(&attempt, "failed", Some(&ce), None, None);
            }
        }
        out
    }

    fn fail(&self, c: &CapturedSession, e: CodedError) -> crate::store::Result<CaptureOutcome> {
        if e.code.policy() == Policy::Skip {
            self.store.skip_capture(&c.id, e.code, &e.message)?;
            return Ok(CaptureOutcome::Skipped(e.code));
        }
        Ok(match self.store.fail_capture(&c.id, &e)? {
            CaptureStatus::Failed => CaptureOutcome::Failed(e),
            _ => CaptureOutcome::Retry(e),
        })
    }

    fn run_attempt(
        &self,
        c: &CapturedSession,
        attempt: &str,
    ) -> crate::store::Result<CaptureOutcome> {
        let st = self.store;
        st.set_capture_status(&c.id, CaptureStatus::Redacting)?;
        let path = Path::new(&c.transcript_path);
        let parsed = crate::agents::adapter(c.agent).parse(&c.transcript_path);
        let mut s = match parsed {
            Ok(s) => s,
            Err(e) => {
                // A missing file may still be being written; a too-large one never will fit.
                let code = match e {
                    session::reader::ReadError::Io(..) => ErrorCode::TranscriptMissing,
                    _ => ErrorCode::TranscriptTooLarge,
                };
                return self.fail(c, CodedError::new(code, e.to_string()));
            }
        };
        st.attempt_stage(attempt, "parsed")?;
        if !enabled_for(st, s.meta.cwd.as_deref().or(c.cwd.as_deref())) {
            return self.fail(
                c,
                CodedError::new(
                    ErrorCode::ProjectNotEnabled,
                    "capture is off for this project",
                ),
            );
        }
        if is_trivial(&s) {
            return self.fail(
                c,
                CodedError::new(
                    ErrorCode::EmptySession,
                    "the session has no real conversation",
                ),
            );
        }
        let sha = session::reader::sha256_file(path).unwrap_or_default();
        st.set_capture_meta(
            &c.id,
            &sha,
            s.meta.repo_url.as_deref(),
            s.meta.git_branch.as_deref(),
        )?;
        let counts = session::redact_session(self.rules, &mut s);
        st.attempt_stage(attempt, "redacted")?;
        st.set_capture_status(&c.id, CaptureStatus::Digesting)?;
        let body = request_body(&s, &counts, &c.agent_session_id);
        match self.sink.submit(&body) {
            Ok(v) => {
                st.attempt_stage(attempt, "submitted")?;
                let status = v["status"].as_str().unwrap_or_default().to_string();
                let digest_id = v["digest_id"].as_str().unwrap_or_default().to_string();
                let server_id =
                    (status != "queued" && !digest_id.is_empty()).then_some(digest_id.as_str());
                st.complete_capture(&c.id, server_id)?;
                if let Some(run) = v["run_id"].as_str() {
                    st.attempt_run_id(attempt, run)?;
                }
                Ok(CaptureOutcome::Submitted { digest_id, status })
            }
            Err(SinkError(e)) => self.fail(c, *e),
        }
    }

    /// Process every due capture once.
    pub fn run_due(&self) -> crate::store::Result<Vec<(String, CaptureOutcome)>> {
        self.run_due_with(|| {})
    }

    /// [`Self::run_due`], calling `before_each` before every capture (the drain refreshes its
    /// lock so a long batch is not taken for a dead drain).
    pub fn run_due_with(
        &self,
        mut before_each: impl FnMut(),
    ) -> crate::store::Result<Vec<(String, CaptureOutcome)>> {
        let mut out = Vec::new();
        for c in self.store.due_captures(50)? {
            before_each();
            let o = self.process(&c)?;
            out.push((c.id.clone(), o));
        }
        Ok(out)
    }
}

/// A drain lock older than this belongs to a drain that died; an in-progress capture whose
/// attempt started before it was interrupted.
pub const DRAIN_STALE: Duration = Duration::from_secs(600);

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
        .map(|t| t.elapsed().unwrap_or_default() > DRAIN_STALE)
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
    // Holding the lock: a capture still `redacting`/`digesting` from before the stale window was
    // left by a drain that was killed or failed mid-attempt; put it back on the retry schedule.
    let res = w
        .store
        .recover_interrupted(crate::store::now_ms() - DRAIN_STALE.as_millis() as i64)
        .and_then(|_| {
            w.run_due_with(|| {
                if let Ok(f) = OpenOptions::new().write(true).open(lock) {
                    let _ = f.set_modified(SystemTime::now());
                }
            })
        });
    let _ = std::fs::remove_file(lock);
    res.map(Some)
}

#[cfg(test)]
mod tests {
    use super::{is_trivial, rfc3339};
    use crate::digest::Agent;
    use crate::session::{Event, EventKind, NormalizedSession, SessionMeta};
    use std::time::{Duration, SystemTime};

    fn ev(kind: EventKind, text: &str) -> Event {
        Event {
            kind,
            text: text.into(),
            tool: None,
            path: None,
            command: None,
            call_id: None,
            at: None,
        }
    }

    fn call(tool: &str, command: Option<&str>, path: Option<&str>) -> Event {
        Event {
            tool: Some(tool.into()),
            command: command.map(Into::into),
            path: path.map(Into::into),
            ..ev(EventKind::ToolCall, "")
        }
    }

    fn session(events: Vec<Event>) -> NormalizedSession {
        NormalizedSession {
            meta: SessionMeta::new(Agent::ClaudeCode, "s"),
            events,
            skipped_lines: 0,
        }
    }

    #[test]
    fn a_question_and_a_real_answer_is_not_trivial() {
        let s = session(vec![
            ev(EventKind::User, "Should refunds include shipping?"),
            ev(
                EventKind::Assistant,
                "No, the carrier fee is non-refundable.",
            ),
        ]);
        assert!(!is_trivial(&s));
    }

    #[test]
    fn a_short_request_answered_only_by_tool_calls_is_real_work() {
        let s = session(vec![
            ev(EventKind::User, "fix the failing test"),
            call("edit", None, Some("crates/pama-core/src/store/mod.rs")),
            call("bash", Some("cargo test -p pama-core"), None),
            ev(EventKind::ToolResult, "test result: ok"),
        ]);
        assert!(!is_trivial(&s));
    }

    #[test]
    fn greetings_tool_output_only_and_missing_sides_are_trivial() {
        // A greeting and a one-line reply.
        assert!(is_trivial(&session(vec![
            ev(EventKind::User, "hi"),
            ev(EventKind::Assistant, "Hello! How can I help?"),
        ])));
        // Tool calls and results but no user message (e.g. a resumed session's replay).
        assert!(is_trivial(&session(vec![
            call("bash", Some("cargo test -p pama-core --all-targets"), None),
            ev(EventKind::ToolResult, &"x".repeat(500)),
        ])));
        // A user message nobody acted on; long tool output does not count as conversation.
        assert!(is_trivial(&session(vec![
            ev(
                EventKind::User,
                "Please look at the build failure in CI today"
            ),
            ev(EventKind::ToolResult, &"y".repeat(500)),
        ])));
        assert!(is_trivial(&session(vec![])));
    }

    #[test]
    fn formats_rfc3339() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_686_000);
        assert_eq!(rfc3339(t), "2026-10-22T16:20:00Z");
        assert_eq!(rfc3339(SystemTime::UNIX_EPOCH), "1970-01-01T00:00:00Z");
    }
}
