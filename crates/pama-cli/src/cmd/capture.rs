//! `pama capture drain` (internal): process captured sessions in the background, waiting for
//! debounced ones (up to a few minutes), then exit. Holds a lock so only one drain runs.

use std::time::Duration;

use pama_core::capture::worker::{drain, CaptureOutcome, Worker};
use pama_core::client::LocalApi;
use pama_core::redact::RuleSet;

use super::hook::log;
use super::Ctx;
use crate::{CaptureAction, Exit};

/// Wait at most this long for a debounced capture before exiting (the next hook restarts us).
const MAX_WAIT_MS: i64 = 5 * 60 * 1_000;

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

pub fn run(ctx: &Ctx, action: CaptureAction) -> anyhow::Result<Exit> {
    let CaptureAction::Drain { once } = action;
    let rules = RuleSet::load_dir(&rules_dir())?;
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
        let started = super::server::ensure_started(&ctx.store, false);
        let api = started
            .map_err(|e| e.to_string())
            .and_then(|_| LocalApi::connect(&ctx.store, "cli").map_err(|e| e.to_string()));
        let api = match api {
            Ok(a) => a,
            Err(e) => {
                // No server: count a failed attempt (backoff) and exit; the next hook retries.
                log(&format!("drain: server unavailable: {e}"));
                for c in ctx.store.due_captures(50)? {
                    ctx.store
                        .set_capture_status(&c.id, pama_core::store::CaptureStatus::Redacting)?;
                    ctx.store.fail_capture(&c.id, &e, true)?;
                }
                break;
            }
        };
        let worker = Worker {
            store: &ctx.store,
            rules: &rules,
            sink: api,
        };
        match drain(&worker, &pama_core::paths::drain_lock())? {
            None => break, // another drain is running
            Some(results) => {
                for (id, o) in &results {
                    match o {
                        CaptureOutcome::Submitted { digest_id, status } => {
                            log(&format!("capture {id}: {status} digest {digest_id}"))
                        }
                        other => log(&format!("capture {id}: {other:?}")),
                    }
                }
            }
        }
        if once {
            break;
        }
    }
    Ok(Exit::Ok)
}
