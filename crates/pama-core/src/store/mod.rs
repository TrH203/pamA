//! Device store (SQLite): capture state machine, sync outbox, settings and network log.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Retries after the first failure before a capture or outbox item gives up.
pub const MAX_RETRIES: i64 = 5;
const BASE_BACKOFF_MS: i64 = 2_000;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error("invalid transition {from:?} -> {to:?} for {id}")]
    Transition {
        id: String,
        from: CaptureStatus,
        to: CaptureStatus,
    },
    #[error("not found: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureStatus {
    Detected,
    Redacting,
    Digesting,
    ReadyForReview,
    Submitted,
    Failed,
    Skipped,
}

impl CaptureStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Detected => "detected",
            Self::Redacting => "redacting",
            Self::Digesting => "digesting",
            Self::ReadyForReview => "ready_for_review",
            Self::Submitted => "submitted",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "redacting" => Self::Redacting,
            "digesting" => Self::Digesting,
            "ready_for_review" => Self::ReadyForReview,
            "submitted" => Self::Submitted,
            "failed" => Self::Failed,
            "skipped" => Self::Skipped,
            _ => Self::Detected,
        }
    }

    /// `detected → redacting → digesting → ready_for_review → submitted`; any → `failed`;
    /// `failed → detected` (retry); `detected → skipped`.
    pub fn can_move_to(self, to: Self) -> bool {
        use CaptureStatus::*;
        matches!(
            (self, to),
            (Detected, Redacting)
                | (Redacting, Digesting)
                | (Digesting, ReadyForReview)
                | (ReadyForReview, Submitted)
                | (Failed, Detected)
                | (Detected, Skipped)
                | (Redacting, Skipped)
        ) || (to == Failed && !matches!(self, Submitted | Skipped | Failed))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    ClaudeCode,
    Codex,
}

impl Agent {
    pub fn as_str(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude_code",
            Agent::Codex => "codex",
        }
    }
    fn parse(s: &str) -> Self {
        if s == "codex" {
            Agent::Codex
        } else {
            Agent::ClaudeCode
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewCapture {
    pub agent: Agent,
    pub agent_session_id: String,
    pub transcript_path: String,
    pub cwd: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CapturedSession {
    pub id: String,
    pub agent: Agent,
    pub agent_session_id: String,
    pub transcript_path: String,
    pub transcript_sha256: Option<String>,
    pub cwd: Option<String>,
    pub repo_remote: Option<String>,
    pub git_branch: Option<String>,
    pub reason: Option<String>,
    pub status: CaptureStatus,
    pub error: Option<String>,
    pub attempts: i64,
    pub ended_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxKind {
    DigestUpsert,
    SourceTombstone,
    BundleChange,
}

impl OutboxKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::DigestUpsert => "digest_upsert",
            Self::SourceTombstone => "source_tombstone",
            Self::BundleChange => "bundle_change",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "source_tombstone" => Self::SourceTombstone,
            "bundle_change" => Self::BundleChange,
            _ => Self::DigestUpsert,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OutboxItem {
    /// Also the idempotency key sent to the server.
    pub id: String,
    pub kind: OutboxKind,
    pub target: String,
    pub payload: serde_json::Value,
    pub attempts: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkLogEntry {
    pub id: String,
    pub at: i64,
    pub component: String,
    pub host: String,
    pub purpose: String,
    pub allowed: bool,
}

pub struct Store {
    conn: Connection,
}

fn backoff(attempts: i64) -> i64 {
    BASE_BACKOFF_MS * 2_i64.pow(attempts.clamp(0, 16) as u32)
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5_000)?;
        conn.execute_batch(include_str!("schema.sql"))?;
        Ok(Self { conn })
    }

    // --- captures -----------------------------------------------------------------------

    /// Record an ended session. Re-enqueueing a known session is a no-op unless it failed, in
    /// which case it is reset to `detected` for another try. Returns the capture id.
    /// `delay_ms` postpones processing (debounce: e.g. Codex notifies after every turn, so each
    /// new notification pushes the capture back until the session has been idle).
    pub fn enqueue_capture(&self, c: &NewCapture, delay_ms: i64) -> Result<String> {
        let due = now_ms() + delay_ms;
        let existing: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT id, status FROM captured_session WHERE agent = ?1 AND agent_session_id = ?2",
                params![c.agent.as_str(), c.agent_session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((id, status)) = existing {
            // A session can be resumed after it ended; capture it again when it ends again.
            if matches!(
                status.as_str(),
                "detected" | "failed" | "ready_for_review" | "submitted" | "skipped"
            ) {
                self.conn.execute(
                    "UPDATE captured_session SET status = 'detected', error = NULL, attempts = 0,
                     next_attempt_at = ?4, ended_at = ?2, reason = ?3,
                     cwd = COALESCE(?5, cwd) WHERE id = ?1",
                    params![id, now_ms(), c.reason, due, c.cwd],
                )?;
            }
            return Ok(id);
        }
        let id = ulid::Ulid::generate().to_string();
        self.conn.execute(
            "INSERT INTO captured_session (id, agent, agent_session_id, transcript_path, cwd, reason, status, ended_at, next_attempt_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'detected', ?7, ?8)",
            params![
                id,
                c.agent.as_str(),
                c.agent_session_id,
                c.transcript_path,
                c.cwd,
                c.reason,
                now_ms(),
                due
            ],
        )?;
        Ok(id)
    }

    fn row_to_capture(r: &rusqlite::Row<'_>) -> rusqlite::Result<CapturedSession> {
        Ok(CapturedSession {
            id: r.get("id")?,
            agent: Agent::parse(&r.get::<_, String>("agent")?),
            agent_session_id: r.get("agent_session_id")?,
            transcript_path: r.get("transcript_path")?,
            transcript_sha256: r.get("transcript_sha256")?,
            cwd: r.get("cwd")?,
            repo_remote: r.get("repo_remote")?,
            git_branch: r.get("git_branch")?,
            reason: r.get("reason")?,
            status: CaptureStatus::parse(&r.get::<_, String>("status")?),
            error: r.get("error")?,
            attempts: r.get("attempts")?,
            ended_at: r.get("ended_at")?,
        })
    }

    pub fn capture(&self, id: &str) -> Result<CapturedSession> {
        self.conn
            .query_row(
                "SELECT * FROM captured_session WHERE id = ?1",
                [id],
                Self::row_to_capture,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(id.into()))
    }

    /// Captures in `detected` whose retry time has come, oldest first.
    pub fn due_captures(&self, limit: usize) -> Result<Vec<CapturedSession>> {
        let mut st = self.conn.prepare(
            "SELECT * FROM captured_session WHERE status = 'detected' AND next_attempt_at <= ?1
             ORDER BY ended_at LIMIT ?2",
        )?;
        let rows = st.query_map(params![now_ms(), limit as i64], Self::row_to_capture)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Milliseconds until the next `detected` capture is due (None if there is none).
    pub fn next_due_in(&self) -> Result<Option<i64>> {
        let at: Option<i64> = self.conn.query_row(
            "SELECT min(next_attempt_at) FROM captured_session WHERE status = 'detected'",
            [],
            |r| r.get(0),
        )?;
        Ok(at.map(|t| (t - now_ms()).max(0)))
    }

    pub fn captures(&self, limit: usize) -> Result<Vec<CapturedSession>> {
        let mut st = self
            .conn
            .prepare("SELECT * FROM captured_session ORDER BY ended_at DESC LIMIT ?1")?;
        let rows = st.query_map([limit as i64], Self::row_to_capture)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn set_capture_status(&self, id: &str, to: CaptureStatus) -> Result<()> {
        let from = self.capture(id)?.status;
        if !from.can_move_to(to) {
            return Err(StoreError::Transition {
                id: id.into(),
                from,
                to,
            });
        }
        let processed =
            matches!(to, CaptureStatus::ReadyForReview | CaptureStatus::Submitted).then(now_ms);
        self.conn.execute(
            "UPDATE captured_session SET status = ?2, processed_at = COALESCE(?3, processed_at) WHERE id = ?1",
            params![id, to.as_str(), processed],
        )?;
        Ok(())
    }

    pub fn set_capture_meta(
        &self,
        id: &str,
        sha256: &str,
        repo_remote: Option<&str>,
        git_branch: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE captured_session SET transcript_sha256 = ?2, repo_remote = ?3, git_branch = ?4 WHERE id = ?1",
            params![id, sha256, repo_remote, git_branch],
        )?;
        Ok(())
    }

    /// Record a failure. Retries go back to `detected` with exponential backoff until
    /// [`MAX_RETRIES`] is reached; then the capture stays `failed` with its reason.
    pub fn fail_capture(&self, id: &str, error: &str, retryable: bool) -> Result<CaptureStatus> {
        let c = self.capture(id)?;
        self.set_capture_status(id, CaptureStatus::Failed)?;
        let attempts = c.attempts + 1;
        self.conn.execute(
            "UPDATE captured_session SET error = ?2, attempts = ?3 WHERE id = ?1",
            params![id, error, attempts],
        )?;
        if retryable && attempts <= MAX_RETRIES {
            self.set_capture_status(id, CaptureStatus::Detected)?;
            self.conn.execute(
                "UPDATE captured_session SET next_attempt_at = ?2 WHERE id = ?1",
                params![id, now_ms() + backoff(attempts - 1)],
            )?;
            return Ok(CaptureStatus::Detected);
        }
        Ok(CaptureStatus::Failed)
    }

    // --- outbox -------------------------------------------------------------------------

    pub fn outbox_push(
        &self,
        kind: OutboxKind,
        target: &str,
        payload: &serde_json::Value,
    ) -> Result<String> {
        let id = ulid::Ulid::generate().to_string();
        self.conn.execute(
            "INSERT INTO outbox_item (id, kind, target, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, kind.as_str(), target, payload.to_string(), now_ms()],
        )?;
        Ok(id)
    }

    pub fn outbox_due(&self, limit: usize) -> Result<Vec<OutboxItem>> {
        let mut st = self.conn.prepare(
            "SELECT id, kind, target, payload, attempts, status FROM outbox_item
             WHERE status = 'pending' AND next_attempt_at <= ?1 ORDER BY created_at, id LIMIT ?2",
        )?;
        let rows = st.query_map(params![now_ms(), limit as i64], |r| {
            Ok(OutboxItem {
                id: r.get(0)?,
                kind: OutboxKind::parse(&r.get::<_, String>(1)?),
                target: r.get(2)?,
                payload: serde_json::from_str(&r.get::<_, String>(3)?)
                    .unwrap_or(serde_json::Value::Null),
                attempts: r.get(4)?,
                status: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn outbox_sent(&self, id: &str) -> Result<()> {
        self.conn
            .execute("UPDATE outbox_item SET status = 'sent' WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Back off and retry; mark `dead` after [`MAX_RETRIES`] retries.
    pub fn outbox_failed(&self, id: &str, error: &str) -> Result<()> {
        let attempts: i64 = self.conn.query_row(
            "SELECT attempts FROM outbox_item WHERE id = ?1",
            [id],
            |r| r.get(0),
        )?;
        let attempts = attempts + 1;
        let status = if attempts > MAX_RETRIES {
            "dead"
        } else {
            "pending"
        };
        self.conn.execute(
            "UPDATE outbox_item SET attempts = ?2, status = ?3, last_error = ?4, next_attempt_at = ?5 WHERE id = ?1",
            params![id, attempts, status, error, now_ms() + backoff(attempts - 1)],
        )?;
        Ok(())
    }

    // --- settings -----------------------------------------------------------------------

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // --- network log --------------------------------------------------------------------

    pub fn log_network(
        &self,
        component: &str,
        host: &str,
        purpose: &str,
        allowed: bool,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO network_log (id, at, component, host, purpose, allowed) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                ulid::Ulid::generate().to_string(),
                now_ms(),
                component,
                host,
                purpose,
                allowed
            ],
        )?;
        Ok(())
    }

    pub fn network_log(&self, limit: usize) -> Result<Vec<NetworkLogEntry>> {
        let mut st = self.conn.prepare(
            "SELECT id, at, component, host, purpose, allowed FROM network_log ORDER BY at DESC, id DESC LIMIT ?1",
        )?;
        let rows = st.query_map([limit as i64], |r| {
            Ok(NetworkLogEntry {
                id: r.get(0)?,
                at: r.get(1)?,
                component: r.get(2)?,
                host: r.get(3)?,
                purpose: r.get(4)?,
                allowed: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(id: &str) -> NewCapture {
        NewCapture {
            agent: Agent::ClaudeCode,
            agent_session_id: id.into(),
            transcript_path: format!("/tmp/{id}.jsonl"),
            cwd: Some("/work/shop".into()),
            reason: Some("exit".into()),
        }
    }

    #[test]
    fn capture_state_machine() {
        let s = Store::open_in_memory().unwrap();
        let id = s.enqueue_capture(&cap("s1"), 0).unwrap();
        assert_eq!(
            s.enqueue_capture(&cap("s1"), 0).unwrap(),
            id,
            "idempotent enqueue"
        );
        assert_eq!(s.due_captures(10).unwrap().len(), 1);
        s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
        assert!(s.set_capture_status(&id, CaptureStatus::Submitted).is_err());
        s.set_capture_status(&id, CaptureStatus::Digesting).unwrap();
        s.set_capture_status(&id, CaptureStatus::ReadyForReview)
            .unwrap();
        s.set_capture_status(&id, CaptureStatus::Submitted).unwrap();
        assert!(s.due_captures(10).unwrap().is_empty());
    }

    #[test]
    fn failures_back_off_then_stop() {
        let s = Store::open_in_memory().unwrap();
        let id = s.enqueue_capture(&cap("s2"), 0).unwrap();
        for _ in 0..MAX_RETRIES {
            s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
            assert_eq!(
                s.fail_capture(&id, "model unavailable", true).unwrap(),
                CaptureStatus::Detected
            );
        }
        assert!(
            s.due_captures(10).unwrap().is_empty(),
            "backoff delays the retry"
        );
        s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
        assert_eq!(
            s.fail_capture(&id, "model unavailable", true).unwrap(),
            CaptureStatus::Failed
        );
        let c = s.capture(&id).unwrap();
        assert_eq!(c.error.as_deref(), Some("model unavailable"));
        assert_eq!(c.attempts, MAX_RETRIES + 1);
    }

    #[test]
    fn outbox_and_settings() {
        let s = Store::open_in_memory().unwrap();
        let id = s
            .outbox_push(
                OutboxKind::DigestUpsert,
                "https://pama.acme.vn",
                &serde_json::json!({"a": 1}),
            )
            .unwrap();
        assert_eq!(s.outbox_due(10).unwrap().len(), 1);
        s.outbox_failed(&id, "offline").unwrap();
        assert!(s.outbox_due(10).unwrap().is_empty(), "backoff");
        s.outbox_sent(&id).unwrap();
        s.set_setting("hotkey", "CmdOrCtrl+Shift+A").unwrap();
        s.set_setting("hotkey", "CmdOrCtrl+Shift+P").unwrap();
        assert_eq!(
            s.setting("hotkey").unwrap().as_deref(),
            Some("CmdOrCtrl+Shift+P")
        );
        assert_eq!(s.setting("missing").unwrap(), None);
    }
}
