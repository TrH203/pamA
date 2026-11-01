//! Device store (SQLite): capture state machine, sync outbox, settings and network log.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::capture::errors::{CodedError, ErrorCode, Policy};

/// Retries after the first failure before an outbox item gives up.
pub const MAX_RETRIES: i64 = 5;
const BASE_BACKOFF_MS: i64 = 2_000;

const MINUTE_MS: i64 = 60_000;
/// Capture retry schedule (spec 006): 1 m, 5 m, 30 m, 2 h, then every 6 h ...
pub const CAPTURE_RETRY_STEPS_MS: [i64; 4] =
    [MINUTE_MS, 5 * MINUTE_MS, 30 * MINUTE_MS, 120 * MINUTE_MS];
pub const CAPTURE_RETRY_EVERY_MS: i64 = 6 * 60 * MINUTE_MS;
/// ... for at most 24 h after the first failure.
pub const CAPTURE_RETRY_WINDOW_MS: i64 = 24 * 60 * MINUTE_MS;

/// Delay before the next try after `failures` failures (1-based), `since_first_ms` after the
/// first failure; `None` once the next try would fall outside the 24 h window.
pub fn retry_delay_ms(failures: i64, since_first_ms: i64) -> Option<i64> {
    let i = (failures.max(1) - 1) as usize;
    let delay = CAPTURE_RETRY_STEPS_MS
        .get(i)
        .copied()
        .unwrap_or(CAPTURE_RETRY_EVERY_MS);
    (since_first_ms.max(0) + delay <= CAPTURE_RETRY_WINDOW_MS).then_some(delay)
}

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
    /// `failed → detected` (retry); `detected|redacting|digesting → skipped`.
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
                | (Digesting, Skipped)
        ) || (to == Failed && !matches!(self, Submitted | Skipped | Failed))
    }
}

pub use crate::digest::Agent;

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
    /// Code of the last failure or the reason for a skip ([`ErrorCode`]).
    pub error_code: Option<String>,
    /// The server's digest id once the server has it (`submitted`).
    pub digest_id: Option<String>,
    pub attempts: i64,
    pub next_attempt_at: i64,
    pub ended_at: i64,
    pub processed_at: Option<i64>,
}

/// One processing attempt of a capture (`capture_attempt`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaptureAttempt {
    pub id: String,
    pub capture_id: String,
    /// 1-based, over the whole history of the capture.
    pub attempt: i64,
    /// Last stage reached: `started`, `parsed`, `redacted`, `submitted`.
    pub stage: String,
    /// `succeeded`, `queued`, `skipped`, `retry`, `failed`; `None` while running.
    pub outcome: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
    pub role: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub digest_id: Option<String>,
    pub run_id: Option<String>,
}

/// Captures per status, for `pama status`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CaptureCounts {
    pub detected: i64,
    pub running: i64,
    pub ready_for_review: i64,
    pub submitted: i64,
    pub failed: i64,
    pub skipped: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxKind {
    DigestUpsert,
    SourceTombstone,
    BundleChange,
}

impl OutboxKind {
    pub fn as_str(self) -> &'static str {
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

/// An outbox item the receiver refused or that ran out of retries (`pama sync failed`).
#[derive(Debug, Clone, Serialize)]
pub struct DeadItem {
    pub id: String,
    pub kind: OutboxKind,
    pub target: String,
    pub payload: serde_json::Value,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
}

/// Which items an id or id prefix names (`pama sync retry|drop <id>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutboxMatch {
    None,
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct OutboxCounts {
    pub pending: i64,
    pub sent: i64,
    pub dead: i64,
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

/// The device's copy of a digest drafted for a remote server (`remote_digest`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteDigest {
    pub target: String,
    pub agent: String,
    pub agent_session_id: String,
    pub project_key: String,
    pub digest: serde_json::Value,
    /// `draft`, `approved`, `discarded` or `deleted`.
    pub status: String,
    pub server_digest_id: Option<String>,
    pub version: Option<i64>,
    pub updated_at: i64,
}

impl RemoteDigest {
    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            target: r.get(0)?,
            agent: r.get(1)?,
            agent_session_id: r.get(2)?,
            project_key: r.get(3)?,
            digest: serde_json::from_str(&r.get::<_, String>(4)?)
                .unwrap_or(serde_json::Value::Null),
            status: r.get(5)?,
            server_digest_id: r.get(6)?,
            version: r.get(7)?,
            updated_at: r.get(8)?,
        })
    }
}

pub struct Store {
    conn: Connection,
}

fn backoff(attempts: i64) -> i64 {
    BASE_BACKOFF_MS * 2_i64.pow(attempts.clamp(0, 16) as u32)
}

fn ensure_column(conn: &Connection, table: &str, col: &str, decl: &str) -> rusqlite::Result<()> {
    let mut st = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = st
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|c| c == col);
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"))?;
    }
    Ok(())
}

const ATTEMPT_COLUMNS: &str =
    "id, capture_id, attempt, stage, outcome, started_at, ended_at, duration_ms,
  error_code, error_detail, role, provider, model, digest_id, run_id";

fn row_to_attempt(r: &rusqlite::Row<'_>) -> rusqlite::Result<CaptureAttempt> {
    Ok(CaptureAttempt {
        id: r.get(0)?,
        capture_id: r.get(1)?,
        attempt: r.get(2)?,
        stage: r.get(3)?,
        outcome: r.get(4)?,
        started_at: r.get(5)?,
        ended_at: r.get(6)?,
        duration_ms: r.get(7)?,
        error_code: r.get(8)?,
        error_detail: r.get(9)?,
        role: r.get(10)?,
        provider: r.get(11)?,
        model: r.get(12)?,
        digest_id: r.get(13)?,
        run_id: r.get(14)?,
    })
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
        Self::widen_agent_check(&conn)?;
        conn.execute_batch(include_str!("schema.sql"))?;
        // Columns added after the first release (spec 006): older device.db files lack them.
        for (col, decl) in [
            ("error_code", "TEXT"),
            ("digest_id", "TEXT"),
            ("first_failed_at", "INTEGER"),
        ] {
            ensure_column(&conn, "captured_session", col, decl)?;
        }
        Ok(Self { conn })
    }

    /// Device stores created before spec 005 only allowed `claude_code` and `codex`: rebuild
    /// `captured_session` with the wider CHECK (SQLite cannot alter a constraint in place).
    fn widen_agent_check(conn: &Connection) -> Result<()> {
        let sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'captured_session'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if !sql.is_some_and(|s| s.contains("('claude_code', 'codex')")) {
            return Ok(());
        }
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE captured_session RENAME TO captured_session_old;",
        )?;
        let create = include_str!("schema.sql")
            .split(';')
            .find(|s| s.contains("CREATE TABLE IF NOT EXISTS captured_session"))
            .expect("schema has captured_session")
            .to_string();
        conn.execute_batch(&format!(
            "{create};
             INSERT INTO captured_session SELECT * FROM captured_session_old;
             DROP TABLE captured_session_old;
             COMMIT;"
        ))?;
        Ok(())
    }

    // --- captures -----------------------------------------------------------------------

    /// Record an ended session. A known session that is not being processed is reset to
    /// `detected` for another try; its attempt history and last error are kept. Returns the
    /// capture id.
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
                    "UPDATE captured_session SET status = 'detected', attempts = 0,
                     first_failed_at = NULL, next_attempt_at = ?4, ended_at = ?2, reason = ?3,
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
            error_code: r.get("error_code")?,
            digest_id: r.get("digest_id")?,
            attempts: r.get("attempts")?,
            next_attempt_at: r.get("next_attempt_at")?,
            ended_at: r.get("ended_at")?,
            processed_at: r.get("processed_at")?,
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

    /// The capture of one agent session, if this device saw it (`pama sessions show`).
    pub fn capture_for_session(
        &self,
        agent: &str,
        agent_session_id: &str,
    ) -> Result<Option<CapturedSession>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM captured_session WHERE agent = ?1 AND agent_session_id = ?2",
                params![agent, agent_session_id],
                Self::row_to_capture,
            )
            .optional()?)
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

    /// Record a coded failure. Retryable codes go back to `detected` on the retry schedule
    /// ([`retry_delay_ms`]) until the 24 h window is used up; configuration errors and inputs
    /// that will never work stay `failed` until the user retries.
    pub fn fail_capture(&self, id: &str, err: &CodedError) -> Result<CaptureStatus> {
        let c = self.capture(id)?;
        self.set_capture_status(id, CaptureStatus::Failed)?;
        let attempts = c.attempts + 1;
        let now = now_ms();
        let first: Option<i64> = self.conn.query_row(
            "SELECT first_failed_at FROM captured_session WHERE id = ?1",
            [id],
            |r| r.get(0),
        )?;
        let first = first.unwrap_or(now);
        self.conn.execute(
            "UPDATE captured_session SET error = ?2, error_code = ?3, attempts = ?4,
             first_failed_at = ?5 WHERE id = ?1",
            params![id, err.message, err.code.as_str(), attempts, first],
        )?;
        if err.code.policy() == Policy::Retry {
            if let Some(delay) = retry_delay_ms(attempts, now - first) {
                self.set_capture_status(id, CaptureStatus::Detected)?;
                self.conn.execute(
                    "UPDATE captured_session SET next_attempt_at = ?2 WHERE id = ?1",
                    params![id, now + delay],
                )?;
                return Ok(CaptureStatus::Detected);
            }
        }
        Ok(CaptureStatus::Failed)
    }

    /// Skip a capture; the reason is always a code (project_not_enabled, sync_not_enabled,
    /// empty_session).
    pub fn skip_capture(&self, id: &str, code: ErrorCode, detail: &str) -> Result<()> {
        self.set_capture_status(id, CaptureStatus::Skipped)?;
        self.conn.execute(
            "UPDATE captured_session SET error_code = ?2, error = ?3 WHERE id = ?1",
            params![id, code.as_str(), detail],
        )?;
        Ok(())
    }

    /// The sink accepted the capture. With the server's digest id it is `submitted`; without
    /// one (queued on the device for a remote server) it waits in `ready_for_review`.
    pub fn complete_capture(&self, id: &str, digest_id: Option<&str>) -> Result<CaptureStatus> {
        self.set_capture_status(id, CaptureStatus::ReadyForReview)?;
        self.conn.execute(
            "UPDATE captured_session SET error = NULL, error_code = NULL, first_failed_at = NULL
             WHERE id = ?1",
            [id],
        )?;
        let Some(d) = digest_id else {
            return Ok(CaptureStatus::ReadyForReview);
        };
        self.set_capture_status(id, CaptureStatus::Submitted)?;
        self.conn.execute(
            "UPDATE captured_session SET digest_id = ?2 WHERE id = ?1",
            params![id, d],
        )?;
        Ok(CaptureStatus::Submitted)
    }

    /// A queued draft reached the server (remote mode): record its digest id.
    pub fn mark_submitted(
        &self,
        agent: &str,
        agent_session_id: &str,
        digest_id: &str,
    ) -> Result<bool> {
        Ok(self.conn.execute(
            "UPDATE captured_session SET status = 'submitted', digest_id = ?3,
             processed_at = COALESCE(processed_at, ?4)
             WHERE agent = ?1 AND agent_session_id = ?2 AND status IN ('ready_for_review', 'submitted')",
            params![agent, agent_session_id, digest_id, now_ms()],
        )? > 0)
    }

    /// Put a failed or skipped capture back in the queue now (`pama activity retry`). History
    /// stays. Returns false when the capture is not failed or skipped.
    pub fn retry_capture(&self, id: &str) -> Result<bool> {
        Ok(self.conn.execute(
            "UPDATE captured_session SET status = 'detected', attempts = 0, first_failed_at = NULL,
             next_attempt_at = ?2 WHERE id = ?1 AND status IN ('failed', 'skipped')",
            params![id, now_ms()],
        )? > 0)
    }

    /// Retry every failed capture now. Returns how many were queued.
    pub fn retry_all_failed(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE captured_session SET status = 'detected', attempts = 0, first_failed_at = NULL,
             next_attempt_at = ?1 WHERE status = 'failed'",
            [now_ms()],
        )?)
    }

    /// A capture by id, unique id prefix (at least 6 characters) or agent session id.
    pub fn find_capture(&self, key: &str) -> Result<CapturedSession> {
        if let Ok(c) = self.capture(key) {
            return Ok(c);
        }
        let mut st = self.conn.prepare(
            "SELECT * FROM captured_session WHERE agent_session_id = ?1
             OR (length(?1) >= 6 AND id LIKE ?1 || '%') LIMIT 2",
        )?;
        let rows: Vec<CapturedSession> = st
            .query_map([key], Self::row_to_capture)?
            .collect::<rusqlite::Result<_>>()?;
        match rows.len() {
            1 => Ok(rows.into_iter().next().expect("one row")),
            _ => Err(StoreError::NotFound(key.into())),
        }
    }

    pub fn capture_counts(&self) -> Result<CaptureCounts> {
        let mut c = CaptureCounts::default();
        let mut st = self
            .conn
            .prepare("SELECT status, count(*) FROM captured_session GROUP BY status")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (status, n) = row?;
            match status.as_str() {
                "detected" => c.detected = n,
                "redacting" | "digesting" => c.running += n,
                "ready_for_review" => c.ready_for_review = n,
                "submitted" => c.submitted = n,
                "failed" => c.failed = n,
                _ => c.skipped = n,
            }
        }
        Ok(c)
    }

    /// Captures in one status, newest first.
    pub fn captures_with_status(
        &self,
        status: CaptureStatus,
        limit: usize,
    ) -> Result<Vec<CapturedSession>> {
        let mut st = self.conn.prepare(
            "SELECT * FROM captured_session WHERE status = ?1 ORDER BY ended_at DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![status.as_str(), limit as i64], Self::row_to_capture)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // --- capture attempts (spec 006) ------------------------------------------------------

    pub fn start_attempt(&self, capture_id: &str) -> Result<String> {
        let id = ulid::Ulid::generate().to_string();
        let n: i64 = self.conn.query_row(
            "SELECT count(*) FROM capture_attempt WHERE capture_id = ?1",
            [capture_id],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO capture_attempt (id, capture_id, attempt, stage, started_at)
             VALUES (?1, ?2, ?3, 'started', ?4)",
            params![id, capture_id, n + 1, now_ms()],
        )?;
        Ok(id)
    }

    /// The server's run id for this attempt (from its reply).
    pub fn attempt_run_id(&self, attempt_id: &str, run_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE capture_attempt SET run_id = ?2 WHERE id = ?1",
            params![attempt_id, run_id],
        )?;
        Ok(())
    }

    pub fn attempt_stage(&self, attempt_id: &str, stage: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE capture_attempt SET stage = ?2 WHERE id = ?1",
            params![attempt_id, stage],
        )?;
        Ok(())
    }

    /// End an attempt with its outcome and, for a failure or skip, the coded error.
    pub fn finish_attempt(
        &self,
        attempt_id: &str,
        outcome: &str,
        err: Option<&CodedError>,
        digest_id: Option<&str>,
        run_id: Option<&str>,
    ) -> Result<()> {
        let now = now_ms();
        self.conn.execute(
            "UPDATE capture_attempt SET outcome = ?2, ended_at = ?3, duration_ms = ?3 - started_at,
             error_code = ?4, error_detail = ?5, role = ?6, provider = ?7, model = ?8,
             digest_id = ?9, run_id = COALESCE(?10, ?11, run_id) WHERE id = ?1",
            params![
                attempt_id,
                outcome,
                now,
                err.map(|e| e.code.as_str()),
                err.map(|e| e.message.as_str()),
                err.and_then(|e| e.role.as_deref()),
                err.and_then(|e| e.provider.as_deref()),
                err.and_then(|e| e.model.as_deref()),
                digest_id,
                run_id,
                err.and_then(|e| e.run_id.as_deref()),
            ],
        )?;
        Ok(())
    }

    /// Every attempt of a capture, oldest first.
    pub fn attempts(&self, capture_id: &str) -> Result<Vec<CaptureAttempt>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {ATTEMPT_COLUMNS} FROM capture_attempt WHERE capture_id = ?1 ORDER BY attempt"
        ))?;
        let rows = st.query_map([capture_id], row_to_attempt)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The most recent failed attempt over all captures (for `pama status`).
    pub fn latest_failed_attempt(&self) -> Result<Option<CaptureAttempt>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {ATTEMPT_COLUMNS} FROM capture_attempt WHERE error_code IS NOT NULL
                     AND outcome IN ('failed', 'retry') ORDER BY started_at DESC, id DESC LIMIT 1"
                ),
                [],
                row_to_attempt,
            )
            .optional()?)
    }

    /// Attempts that ended after `since` (ms), oldest first (`pama activity --follow`).
    pub fn attempts_since(&self, since: i64, limit: usize) -> Result<Vec<CaptureAttempt>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {ATTEMPT_COLUMNS} FROM capture_attempt WHERE COALESCE(ended_at, started_at) > ?1
             ORDER BY COALESCE(ended_at, started_at), id LIMIT ?2"
        ))?;
        let rows = st.query_map(params![since, limit as i64], row_to_attempt)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
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

    /// Rejected by the receiver (e.g. 409, 422): retrying will not help.
    pub fn outbox_dead(&self, id: &str, error: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE outbox_item SET status = 'dead', last_error = ?2, attempts = attempts + 1 WHERE id = ?1",
            params![id, error],
        )?;
        Ok(())
    }

    /// Make every pending item due now ("sync now", or after the owner fixed the network).
    pub fn outbox_retry_now(&self) -> Result<()> {
        self.conn.execute(
            "UPDATE outbox_item SET next_attempt_at = 0 WHERE status = 'pending'",
            [],
        )?;
        Ok(())
    }

    /// Dead items, newest first, with the receiver's last answer.
    pub fn outbox_dead_items(&self, limit: usize) -> Result<Vec<DeadItem>> {
        let mut st = self.conn.prepare(
            "SELECT id, kind, target, payload, attempts, last_error, created_at FROM outbox_item
             WHERE status = 'dead' ORDER BY created_at DESC, id DESC LIMIT ?1",
        )?;
        let rows = st.query_map([limit as i64], |r| {
            Ok(DeadItem {
                id: r.get(0)?,
                kind: OutboxKind::parse(&r.get::<_, String>(1)?),
                target: r.get(2)?,
                payload: serde_json::from_str(&r.get::<_, String>(3)?)
                    .unwrap_or(serde_json::Value::Null),
                attempts: r.get(4)?,
                last_error: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The dead items an id or a unique id prefix (at least 4 characters) names.
    pub fn outbox_match_dead(&self, id: &str) -> Result<OutboxMatch> {
        let id = id.trim();
        if id.len() < 4 {
            let exact: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM outbox_item WHERE status = 'dead' AND id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            return Ok(exact.map_or(OutboxMatch::None, OutboxMatch::One));
        }
        let mut st = self.conn.prepare(
            "SELECT id FROM outbox_item WHERE status = 'dead' AND (id = ?1 OR substr(id, 1, length(?1)) = ?1)
             ORDER BY created_at, id",
        )?;
        let ids: Vec<String> = st
            .query_map([id.to_uppercase()], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(match ids.len() {
            0 => OutboxMatch::None,
            1 => OutboxMatch::One(ids.into_iter().next().unwrap_or_default()),
            _ => OutboxMatch::Many(ids),
        })
    }

    /// Give a dead item another full set of tries, due now. Returns whether it was dead.
    pub fn outbox_revive(&self, id: &str) -> Result<bool> {
        Ok(self.conn.execute(
            "UPDATE outbox_item SET status = 'pending', attempts = 0, next_attempt_at = 0 WHERE id = ?1 AND status = 'dead'",
            [id],
        )? > 0)
    }

    /// Revive every dead item. Returns how many.
    pub fn outbox_revive_all(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE outbox_item SET status = 'pending', attempts = 0, next_attempt_at = 0 WHERE status = 'dead'",
            [],
        )?)
    }

    /// Forget a dead item for good. Returns whether it existed.
    pub fn outbox_drop(&self, id: &str) -> Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM outbox_item WHERE id = ?1 AND status = 'dead'",
            [id],
        )? > 0)
    }

    pub fn outbox_counts(&self) -> Result<OutboxCounts> {
        let mut c = OutboxCounts::default();
        let mut st = self
            .conn
            .prepare("SELECT status, count(*) FROM outbox_item GROUP BY status")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (status, n) = row?;
            match status.as_str() {
                "pending" => c.pending = n,
                "sent" => c.sent = n,
                _ => c.dead = n,
            }
        }
        Ok(c)
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

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM settings WHERE key = ?1", [key])?;
        Ok(())
    }

    // --- remote digests (thin client) ---------------------------------------------------

    /// Keep the device's copy of a digest drafted for `target` (the source of truth, FR-025).
    pub fn put_remote_digest(&self, d: &RemoteDigest) -> Result<()> {
        self.conn.execute(
            "INSERT INTO remote_digest (target, agent, agent_session_id, project_key, digest, status, server_digest_id, version, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (target, agent, agent_session_id) DO UPDATE SET
               project_key = excluded.project_key, digest = excluded.digest, status = excluded.status,
               server_digest_id = COALESCE(excluded.server_digest_id, remote_digest.server_digest_id),
               version = COALESCE(excluded.version, remote_digest.version), updated_at = excluded.updated_at",
            params![
                d.target,
                d.agent,
                d.agent_session_id,
                d.project_key,
                d.digest.to_string(),
                d.status,
                d.server_digest_id,
                d.version,
                now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn remote_digest(
        &self,
        target: &str,
        agent: &str,
        agent_session_id: &str,
    ) -> Result<Option<RemoteDigest>> {
        Ok(self
            .conn
            .query_row(
                "SELECT target, agent, agent_session_id, project_key, digest, status, server_digest_id, version, updated_at
                 FROM remote_digest WHERE target = ?1 AND agent = ?2 AND agent_session_id = ?3",
                params![target, agent, agent_session_id],
                RemoteDigest::from_row,
            )
            .optional()?)
    }

    pub fn remote_digests(&self, target: &str) -> Result<Vec<RemoteDigest>> {
        let mut st = self.conn.prepare(
            "SELECT target, agent, agent_session_id, project_key, digest, status, server_digest_id, version, updated_at
             FROM remote_digest WHERE target = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = st.query_map([target], RemoteDigest::from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Sync turned off for a project: its copies stay on the device but are marked deleted
    /// remotely (the tombstone always wins over the server).
    pub fn mark_remote_project_deleted(&self, target: &str, project_key: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE remote_digest SET status = 'deleted', updated_at = ?3 WHERE target = ?1 AND project_key = ?2",
            params![target, project_key, now_ms()],
        )?)
    }

    /// Sync turned off for one task in remote mode: mark its copies deleted remotely.
    pub fn mark_remote_bundle_deleted(
        &self,
        target: &str,
        project_key: &str,
        bundle_key: &str,
    ) -> Result<usize> {
        let mut n = 0;
        for d in self.remote_digests(target)? {
            if d.project_key == project_key
                && d.digest["source"]["bundle_key"].as_str() == Some(bundle_key)
                && d.status != "deleted"
            {
                n += self.conn.execute(
                    "UPDATE remote_digest SET status = 'deleted', updated_at = ?4 WHERE target = ?1 AND agent = ?2 AND agent_session_id = ?3",
                    params![target, d.agent, d.agent_session_id, now_ms()],
                )?;
            }
        }
        Ok(n)
    }

    /// Pending outbox items for one server (logout).
    pub fn outbox_pending_for(&self, target: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT count(*) FROM outbox_item WHERE status = 'pending' AND target = ?1",
            [target],
            |r| r.get(0),
        )?)
    }

    /// Give up on everything pending for `target` (logout --discard-pending).
    pub fn outbox_discard_for(&self, target: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE outbox_item SET status = 'dead', last_error = 'discarded at logout' WHERE status = 'pending' AND target = ?1",
            [target],
        )?)
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

    fn err(code: ErrorCode) -> CodedError {
        CodedError::new(code, format!("{code} happened"))
    }

    #[test]
    fn retry_schedule() {
        let m = 60_000;
        assert_eq!(retry_delay_ms(1, 0), Some(m));
        assert_eq!(retry_delay_ms(2, m), Some(5 * m));
        assert_eq!(retry_delay_ms(3, 6 * m), Some(30 * m));
        assert_eq!(retry_delay_ms(4, 36 * m), Some(120 * m));
        assert_eq!(retry_delay_ms(5, 156 * m), Some(360 * m));
        assert_eq!(retry_delay_ms(9, 156 * m), Some(360 * m));
        // The window closes 24 h after the first failure.
        assert_eq!(retry_delay_ms(7, 20 * 60 * m), None);
        assert_eq!(retry_delay_ms(6, 18 * 60 * m), Some(360 * m));
        // Full schedule: 1m 5m 30m 2h 6h 6h 6h = 20h36m, the next 6 h would pass 24 h.
        let (mut t, mut n) = (0, 0);
        while let Some(d) = retry_delay_ms(n + 1, t) {
            t += d;
            n += 1;
        }
        assert_eq!(n, 7);
        assert_eq!(t, (20 * 60 + 36) * m);
    }

    #[test]
    fn retryable_failures_back_off_on_the_schedule() {
        let s = Store::open_in_memory().unwrap();
        let id = s.enqueue_capture(&cap("s2"), 0).unwrap();
        s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
        assert_eq!(
            s.fail_capture(&id, &err(ErrorCode::ProviderUnreachable))
                .unwrap(),
            CaptureStatus::Detected
        );
        let c = s.capture(&id).unwrap();
        assert_eq!(c.error_code.as_deref(), Some("provider_unreachable"));
        assert_eq!(c.attempts, 1);
        let wait = c.next_attempt_at - now_ms();
        assert!(
            (55_000..=60_000).contains(&wait),
            "first retry after 1 minute: {wait}"
        );
        assert!(s.due_captures(10).unwrap().is_empty());
        // Past the 24 h window it stops.
        s.conn
            .execute(
                "UPDATE captured_session SET first_failed_at = ?2 WHERE id = ?1",
                params![id, now_ms() - CAPTURE_RETRY_WINDOW_MS],
            )
            .unwrap();
        s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
        assert_eq!(
            s.fail_capture(&id, &err(ErrorCode::ProviderUnreachable))
                .unwrap(),
            CaptureStatus::Failed
        );
    }

    #[test]
    fn config_errors_wait_for_the_user() {
        let s = Store::open_in_memory().unwrap();
        let id = s.enqueue_capture(&cap("s3"), 0).unwrap();
        s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
        assert_eq!(
            s.fail_capture(&id, &err(ErrorCode::ProviderAuth)).unwrap(),
            CaptureStatus::Failed
        );
        assert_eq!(s.capture_counts().unwrap().failed, 1);
        assert!(s.retry_capture(&id).unwrap());
        assert_eq!(s.due_captures(10).unwrap().len(), 1);
        assert!(!s.retry_capture(&id).unwrap(), "only failed or skipped");
    }

    #[test]
    fn attempt_history_survives_re_enqueue() {
        let s = Store::open_in_memory().unwrap();
        let id = s.enqueue_capture(&cap("s4"), 0).unwrap();
        let a1 = s.start_attempt(&id).unwrap();
        s.attempt_stage(&a1, "parsed").unwrap();
        s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
        let mut e = err(ErrorCode::ProviderAuth);
        e.role = Some("small".into());
        e.run_id = Some("run1".into());
        s.fail_capture(&id, &e).unwrap();
        s.finish_attempt(&a1, "failed", Some(&e), None, None)
            .unwrap();

        // The session is resumed and ends again: queued again, history kept.
        s.enqueue_capture(&cap("s4"), 0).unwrap();
        let c = s.capture(&id).unwrap();
        assert_eq!(c.status, CaptureStatus::Detected);
        assert_eq!(
            c.error_code.as_deref(),
            Some("provider_auth"),
            "last error kept"
        );
        let a2 = s.start_attempt(&id).unwrap();
        s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
        s.set_capture_status(&id, CaptureStatus::Digesting).unwrap();
        assert_eq!(
            s.complete_capture(&id, Some("dg1")).unwrap(),
            CaptureStatus::Submitted
        );
        s.finish_attempt(&a2, "succeeded", None, Some("dg1"), Some("run2"))
            .unwrap();

        let h = s.attempts(&id).unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].attempt, 1);
        assert_eq!(h[0].stage, "parsed");
        assert_eq!(h[0].error_code.as_deref(), Some("provider_auth"));
        assert_eq!(h[0].role.as_deref(), Some("small"));
        assert_eq!(h[0].run_id.as_deref(), Some("run1"));
        assert!(h[0].duration_ms.unwrap() >= 0);
        assert_eq!(h[1].outcome.as_deref(), Some("succeeded"));
        assert_eq!(h[1].digest_id.as_deref(), Some("dg1"));
        let c = s.capture(&id).unwrap();
        assert_eq!(c.status, CaptureStatus::Submitted);
        assert_eq!(c.digest_id.as_deref(), Some("dg1"));
        assert_eq!(c.error_code, None);
        assert_eq!(s.latest_failed_attempt().unwrap().unwrap().id, a1);
        assert_eq!(s.find_capture("s4").unwrap().id, id);
        assert_eq!(s.find_capture(&id[..8]).unwrap().id, id);
    }

    #[test]
    fn queued_drafts_become_submitted_when_delivered() {
        let s = Store::open_in_memory().unwrap();
        let id = s.enqueue_capture(&cap("s5"), 0).unwrap();
        s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
        s.set_capture_status(&id, CaptureStatus::Digesting).unwrap();
        assert_eq!(
            s.complete_capture(&id, None).unwrap(),
            CaptureStatus::ReadyForReview
        );
        assert!(s.mark_submitted("claude_code", "s5", "srv-dg").unwrap());
        let c = s.capture(&id).unwrap();
        assert_eq!(c.status, CaptureStatus::Submitted);
        assert_eq!(c.digest_id.as_deref(), Some("srv-dg"));
    }

    #[test]
    fn skips_keep_a_reason_code() {
        let s = Store::open_in_memory().unwrap();
        let id = s.enqueue_capture(&cap("s6"), 0).unwrap();
        s.set_capture_status(&id, CaptureStatus::Redacting).unwrap();
        s.skip_capture(&id, ErrorCode::EmptySession, "no conversation")
            .unwrap();
        let c = s.capture(&id).unwrap();
        assert_eq!(c.status, CaptureStatus::Skipped);
        assert_eq!(c.error_code.as_deref(), Some("empty_session"));
    }

    #[test]
    fn old_device_db_gains_new_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE captured_session (id TEXT PRIMARY KEY, agent TEXT NOT NULL, agent_session_id TEXT NOT NULL,
               transcript_path TEXT NOT NULL, transcript_sha256 TEXT, cwd TEXT, repo_remote TEXT, git_branch TEXT,
               reason TEXT, status TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
               next_attempt_at INTEGER NOT NULL DEFAULT 0, ended_at INTEGER NOT NULL, processed_at INTEGER,
               UNIQUE (agent, agent_session_id));",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let id = s.enqueue_capture(&cap("old"), 0).unwrap();
        assert_eq!(s.capture(&id).unwrap().error_code, None);
    }

    #[test]
    fn dead_items_can_be_listed_retried_and_dropped() {
        let s = Store::open_in_memory().unwrap();
        let t = "https://pama.acme.vn";
        let a = s
            .outbox_push(OutboxKind::DigestUpsert, t, &serde_json::json!({"n": 1}))
            .unwrap();
        let b = s
            .outbox_push(OutboxKind::SourceTombstone, t, &serde_json::json!({"n": 2}))
            .unwrap();
        s.outbox_dead(&a, "server returned 422: invalid").unwrap();
        s.outbox_dead(&b, "server returned 409: stale").unwrap();
        let dead = s.outbox_dead_items(10).unwrap();
        assert_eq!(dead.len(), 2);
        assert!(dead
            .iter()
            .any(|d| d.last_error.as_deref() == Some("server returned 422: invalid")));
        assert_eq!(s.outbox_counts().unwrap().dead, 2);

        assert_eq!(
            s.outbox_match_dead(&a.to_lowercase()).unwrap(),
            OutboxMatch::One(a.clone())
        );
        assert_eq!(s.outbox_match_dead("zz").unwrap(), OutboxMatch::None);
        // Both ULIDs were made in the same millisecond range: a short shared prefix is ambiguous.
        let shared: String = a
            .chars()
            .zip(b.chars())
            .take_while(|(x, y)| x == y)
            .map(|(x, _)| x)
            .collect();
        if shared.len() >= 4 {
            assert!(matches!(
                s.outbox_match_dead(&shared).unwrap(),
                OutboxMatch::Many(_)
            ));
        }

        assert!(s.outbox_revive(&a).unwrap());
        assert!(!s.outbox_revive(&a).unwrap(), "only dead items");
        assert_eq!(s.outbox_due(10).unwrap().len(), 1, "due right away");
        assert_eq!(s.outbox_due(10).unwrap()[0].attempts, 0);
        assert!(s.outbox_drop(&b).unwrap());
        assert!(s.outbox_dead_items(10).unwrap().is_empty());
        s.outbox_dead(&a, "again").unwrap();
        assert_eq!(s.outbox_revive_all().unwrap(), 1);
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
