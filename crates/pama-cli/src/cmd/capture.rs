//! `pama capture drain` (internal): process captured sessions in the background, waiting for
//! debounced ones (up to a few minutes), then exit. Holds a lock so only one drain runs.
//! Local mode drafts on the local server; remote mode (spec 004) drafts on this machine.
//!
//! A drain does not wait for retries further away than [`MAX_WAIT_MS`] (30 m, 2 h, 6 h). Those
//! run when something starts a drain after they are due: an agent hook (every ended session),
//! the desktop app (every minute), or any owner command on a CLI-only install ([`kick_due`],
//! at most once a minute; `pama scan` and `pama status` included).

use std::time::Duration;

use pama_core::capture::errors::{from_draft, CodedError, ErrorCode};
use pama_core::capture::worker::{drain, CaptureOutcome, Worker};
use pama_core::client::Api;
use pama_core::draft::llm::HttpModel;
use pama_core::draft::DraftError;
use pama_core::redact::RuleSet;
use pama_core::remote::{self, Mode, RemoteSink};
use pama_core::sync::{deliver_due, HttpRemote};

use super::hook::log;
use super::Ctx;
use crate::{CaptureAction, Exit};

/// Wait at most this long for a debounced capture before exiting (the next hook restarts us).
const MAX_WAIT_MS: i64 = 5 * 60 * 1_000;

/// When the last command started a drain for due captures (ms, device setting).
const KEY_LAST_KICK: &str = "capture.last_kick";
const KICK_EVERY_MS: i64 = 60 * 1_000;

/// Start a background drain when a retry is due, at most once a minute. Owner commands call
/// this so a CLI-only install (no desktop app) still runs the later retries (30 m, 2 h, 6 h)
/// that an exiting drain did not wait for. Captures that never failed are left to the drain
/// their hook started, and nothing starts while a drain holds its lock.
pub fn kick_due(ctx: &Ctx) {
    let lock = pama_core::paths::drain_lock();
    let draining = std::fs::metadata(&lock)
        .and_then(|m| m.modified())
        .map(|t| t.elapsed().unwrap_or_default() < pama_core::capture::worker::DRAIN_STALE)
        .unwrap_or(false);
    if !draining && should_kick(&ctx.store, pama_core::store::now_ms()) {
        super::hook::spawn_drain();
    }
}

/// Whether a retry is due at `now` and no command started a drain in the last minute; records
/// the start when it returns true.
fn should_kick(store: &pama_core::store::Store, now: i64) -> bool {
    if !store.retry_due(now).unwrap_or(false) {
        return false;
    }
    let last = store
        .setting(KEY_LAST_KICK)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if (0..KICK_EVERY_MS).contains(&(now - last)) {
        return false;
    }
    store.set_setting(KEY_LAST_KICK, &now.to_string()).is_ok()
}

pub fn rules_dir() -> std::path::PathBuf {
    if let Some(d) = std::env::var_os("PAMA_RULES_DIR") {
        return d.into();
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()));
    if let Some(d) = exe_dir.map(|d| d.join("rules")).filter(|d| d.exists()) {
        return d;
    }
    // Development checkout.
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../rules")
}

fn log_results(results: &[(String, CaptureOutcome)]) {
    for (id, o) in results {
        match o {
            CaptureOutcome::Submitted { digest_id, status } => {
                log(&format!("capture {id}: {status} digest {digest_id}"))
            }
            CaptureOutcome::Skipped(code) => log(&format!("capture {id}: skipped ({code})")),
            CaptureOutcome::Retry(e) => log(&format!("capture {id}: will retry: {e}")),
            CaptureOutcome::Failed(e) => log(&format!("capture {id}: failed: {e}")),
        }
    }
}

/// Local mode: the local server drafts (started if needed). `Ok(false)`: another drain runs.
#[allow(clippy::result_large_err)] // one per drain, not a hot path
fn drain_local(ctx: &Ctx, rules: &RuleSet) -> Result<bool, CodedError> {
    super::server::ensure_started(&ctx.store, false)
        .map_err(|e| CodedError::new(ErrorCode::ServerDown, e.to_string()))?;
    let api = Api::connect(&ctx.store, "cli").map_err(|e| e.coded())?;
    let worker = Worker {
        store: &ctx.store,
        rules,
        sink: api,
    };
    match drain(&worker, &pama_core::paths::drain_lock())
        .map_err(|e| CodedError::new(ErrorCode::Internal, e.to_string()))?
    {
        None => Ok(false),
        Some(results) => {
            log_results(&results);
            Ok(true)
        }
    }
}

/// Remote mode (spec 004): draft on this machine, queue only the digest for `target`. No local
/// server is started.
#[allow(clippy::result_large_err)] // one per drain, not a hot path
fn drain_remote(ctx: &Ctx, rules: &RuleSet, target: &str) -> Result<bool, CodedError> {
    let model = HttpModel::new(&ctx.store, "cli").map_err(|e| match e {
        DraftError::Retryable(m) => from_draft(true, &m),
        DraftError::Fatal(m) => from_draft(false, &m),
    })?;
    let worker = Worker {
        store: &ctx.store,
        rules,
        sink: RemoteSink {
            store: &ctx.store,
            rules,
            model: &model,
            target: target.to_string(),
        },
    };
    match drain(&worker, &pama_core::paths::drain_lock())
        .map_err(|e| CodedError::new(ErrorCode::Internal, e.to_string()))?
    {
        None => Ok(false),
        Some(results) => {
            log_results(&results);
            Ok(true)
        }
    }
}

pub fn run(ctx: &Ctx, action: CaptureAction) -> anyhow::Result<Exit> {
    let CaptureAction::Drain { once } = action;
    pama_core::secrets::init_platform_store();
    let rules = RuleSet::load_dir(&rules_dir())?;
    let remote_mode = remote::mode(&ctx.store) == Mode::Remote;
    let target = remote::default_server(&ctx.store);
    loop {
        if ctx.store.due_captures(1)?.is_empty() {
            match ctx.store.next_due_in()? {
                Some(ms) if !once && ms <= MAX_WAIT_MS => {
                    std::thread::sleep(Duration::from_millis(ms as u64 + 50));
                    continue;
                }
                _ => break,
            }
        }
        let done = match (remote_mode, &target) {
            (false, _) => drain_local(ctx, &rules),
            (true, Some(t)) => drain_remote(ctx, &rules, t),
            (true, None) => Err(CodedError::new(
                ErrorCode::NotLoggedIn,
                "remote mode but not logged in (pama login)",
            )),
        };
        match done {
            Ok(true) => {}
            Ok(false) => break, // another drain is running
            Err(e) => {
                // Nowhere to draft: count a failed attempt (backoff) and exit; the next hook
                // or owner command retries.
                log(&format!("drain: cannot draft now: {e}"));
                ctx.store.fail_due(&e)?;
                break;
            }
        }
        if once {
            break;
        }
    }
    if remote_mode {
        // Deliver drafts and deletions, then pull review decisions made on the server.
        match deliver_due(&ctx.store, &HttpRemote::new(&ctx.store)) {
            Ok(r) => log(&format!(
                "deliver: {} sent, {} retrying, {} failed",
                r.sent, r.retrying, r.dead
            )),
            Err(e) => log(&format!("deliver: {e}")),
        }
        if let Some(t) = &target {
            if let Ok(api) = Api::remote(&ctx.store, "cli", t) {
                if let Err(e) = remote::pull_changes(&ctx.store, &api, true) {
                    log(&format!("pull: {e}"));
                }
            }
        }
        return Ok(Exit::Ok);
    }
    // Approved digests of synced sources go out with the same run (no-op when sync is off).
    if let Err(e) = pama_core::sync::sync_once(&ctx.store) {
        log(&format!("sync: {e}"));
    }
    Ok(Exit::Ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pama_core::store::{Agent, NewCapture, Store};

    #[test]
    fn kicks_a_drain_for_due_retries_at_most_once_a_minute() {
        use pama_core::capture::errors::{CodedError, ErrorCode};
        use pama_core::store::CaptureStatus;
        let store = Store::open_in_memory().unwrap();
        let now = pama_core::store::now_ms();
        let id = store
            .enqueue_capture(
                &NewCapture {
                    agent: Agent::ClaudeCode,
                    agent_session_id: "s1".into(),
                    transcript_path: "/tmp/none.jsonl".into(),
                    cwd: None,
                    reason: None,
                },
                0,
            )
            .unwrap();
        assert!(
            !should_kick(&store, now),
            "a new capture is the hook's drain's job"
        );
        store
            .set_capture_status(&id, CaptureStatus::Redacting)
            .unwrap();
        store
            .fail_capture(&id, &CodedError::new(ErrorCode::ServerDown, "down"))
            .unwrap();
        assert!(!should_kick(&store, now), "the retry is a minute away");
        let later = now + 2 * KICK_EVERY_MS;
        assert!(should_kick(&store, later));
        assert!(!should_kick(&store, later + 30_000));
        assert!(should_kick(&store, later + KICK_EVERY_MS));
    }
}
