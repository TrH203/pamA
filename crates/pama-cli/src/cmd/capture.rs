//! `pama capture drain` (internal): process captured sessions in the background, waiting for
//! debounced ones (up to a few minutes), then exit. Holds a lock so only one drain runs.
//! Local mode drafts on the local server; remote mode (spec 004) drafts on this machine.

use std::time::Duration;

use pama_core::capture::worker::{drain, CaptureOutcome, Worker};
use pama_core::client::Api;
use pama_core::draft::llm::HttpModel;
use pama_core::redact::RuleSet;
use pama_core::remote::{self, Mode, RemoteSink};
use pama_core::sync::{deliver_due, HttpRemote};

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

fn log_results(results: &[(String, CaptureOutcome)]) {
    for (id, o) in results {
        match o {
            CaptureOutcome::Submitted { digest_id, status } => {
                log(&format!("capture {id}: {status} digest {digest_id}"))
            }
            other => log(&format!("capture {id}: {other:?}")),
        }
    }
}

/// Local mode: the local server drafts (started if needed). `Ok(false)`: another drain runs.
fn drain_local(ctx: &Ctx, rules: &RuleSet) -> Result<bool, String> {
    super::server::ensure_started(&ctx.store, false).map_err(|e| e.to_string())?;
    let api = Api::connect(&ctx.store, "cli").map_err(|e| e.to_string())?;
    let worker = Worker {
        store: &ctx.store,
        rules,
        sink: api,
    };
    match drain(&worker, &pama_core::paths::drain_lock()).map_err(|e| e.to_string())? {
        None => Ok(false),
        Some(results) => {
            log_results(&results);
            Ok(true)
        }
    }
}

/// Remote mode (spec 004): draft on this machine, queue only the digest for `target`. No local
/// server is started.
fn drain_remote(ctx: &Ctx, rules: &RuleSet, target: &str) -> Result<bool, String> {
    let model = HttpModel::new(&ctx.store, "cli").map_err(|e| e.to_string())?;
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
    match drain(&worker, &pama_core::paths::drain_lock()).map_err(|e| e.to_string())? {
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
            (true, None) => Err("remote mode but not logged in (pama login)".into()),
        };
        match done {
            Ok(true) => {}
            Ok(false) => break, // another drain is running
            Err(e) => {
                // Nowhere to draft: count a failed attempt (backoff) and exit; the next hook
                // retries.
                log(&format!("drain: cannot draft now: {e}"));
                for c in ctx.store.due_captures(50)? {
                    ctx.store
                        .set_capture_status(&c.id, pama_core::store::CaptureStatus::Redacting)?;
                    ctx.store.fail_capture(&c.id, &e, true)?;
                }
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
