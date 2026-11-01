//! While the app runs: pick up ended sessions the hooks missed (watcher fallback), digest queued
//! captures, and notify the owner about new drafts to review, forwarded questions and
//! configuration errors that stop the pipeline (spec 006, at most once per code per hour).
//! In remote mode (spec 004) drafts are made on this machine and queued for the server, and the
//! review and inbox counts come from that server.

use std::time::Duration;

use pama_core::capture::errors::{notification_text, ErrorCode, NotifyGate};
use pama_core::capture::scan::{default_dirs, scan};
use pama_core::capture::worker::{drain, DigestSink, Worker};
use pama_core::client::{Api, LocalApi};
use pama_core::draft::llm::HttpModel;
use pama_core::redact::RuleSet;
use pama_core::remote::{self, Mode, RemoteSink};
use pama_core::store::{now_ms, Store};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::resources;

const INTERVAL: Duration = Duration::from_secs(60);
const IDLE: Duration = Duration::from_secs(120);

pub fn start<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let rules = match RuleSet::load_dir(&resources::locate(&app).rules) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("pama: rules failed to load, capture disabled: {e}");
                return;
            }
        };
        let (claude, codex) = default_dirs();
        let (mut review, mut inbox) = (0usize, 0usize);
        let mut gate = NotifyGate::default();
        let mut checked_at = now_ms();
        // Own SQLite connection: digesting can take a while and must not block the hotkey.
        let store = match pama_core::store::Store::open(&pama_core::paths::device_db()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("pama: device store unavailable: {e}");
                return;
            }
        };
        loop {
            {
                if let Err(e) = scan(
                    &store,
                    claude.as_deref(),
                    codex.as_deref(),
                    Duration::from_secs(86_400),
                    IDLE,
                ) {
                    log_error("scan", &e);
                }
                if let Err(e) = pama_core::sync::sync_once(&store) {
                    log_error("sync", &e);
                }
                drain_due(&store, &rules);
                for code in new_config_errors(&store, &mut checked_at) {
                    if gate.allow(code, now_ms(), NotifyGate::HOUR_MS) {
                        let _ = app.emit("pipeline://error", serde_json::json!({ "code": code }));
                        let _ = app
                            .notification()
                            .builder()
                            .title("pamA needs attention")
                            .body(format!("{} Run `pama status`.", notification_text(code)))
                            .show();
                    }
                }
                if let Ok(api) = Api::resolve(&store, "desktop", None) {
                    let count = |path: &str| {
                        api.get(path, "desktop.poll")
                            .ok()
                            .and_then(|v| v["items"].as_array().map(Vec::len))
                    };
                    if let Some(n) = count("/v1/review") {
                        if n > review {
                            let _ = app.emit("review://new", serde_json::json!({ "count": n }));
                            let _ = app
                                .notification()
                                .builder()
                                .title("pamA")
                                .body(format!("{n} digest(s) to review"))
                                .show();
                        }
                        review = n;
                    }
                    if let Some(n) = count("/v1/inbox") {
                        if n > inbox {
                            let _ = app.emit("inbox://new", serde_json::json!({ "count": n }));
                            let _ = app
                                .notification()
                                .builder()
                                .title("pamA")
                                .body(format!("{n} forwarded question(s)"))
                                .show();
                        }
                        inbox = n;
                    }
                }
            }
            std::thread::sleep(INTERVAL);
        }
    });
}

fn run_worker<S: DigestSink>(store: &Store, rules: &RuleSet, sink: S) {
    let worker = Worker { store, rules, sink };
    if let Err(e) = drain(&worker, &pama_core::paths::drain_lock()) {
        log_error("drain", &e);
    }
}

/// Digest due captures: on the local server, or in remote mode on this machine (queued for the
/// default server). Without a drafter the captures stay queued; `pama status` explains why.
fn drain_due(store: &Store, rules: &RuleSet) {
    if store.due_captures(1).map(|d| d.is_empty()).unwrap_or(true) {
        return;
    }
    if remote::mode(store) == Mode::Remote {
        let Some(target) = remote::default_server(store) else {
            return;
        };
        match HttpModel::new(store, "desktop") {
            Ok(model) => run_worker(
                store,
                rules,
                RemoteSink {
                    store,
                    rules,
                    model: &model,
                    target,
                },
            ),
            Err(e) => log_error("draft model", &format!("{e:?}")),
        }
    } else if let Ok(api) = LocalApi::connect(store, "desktop") {
        run_worker(store, rules, api);
    }
}

/// Configuration error codes of attempts that failed since the last check (skips excluded: a
/// project without capture is not something to nag about).
fn new_config_errors(store: &Store, checked_at: &mut i64) -> Vec<ErrorCode> {
    let Ok(attempts) = store.attempts_since(*checked_at, 200) else {
        return Vec::new();
    };
    let mut codes = Vec::new();
    for a in attempts {
        *checked_at = (*checked_at).max(a.ended_at.unwrap_or(a.started_at));
        if a.outcome.as_deref() == Some("skipped") {
            continue;
        }
        if let Some(c) = a.error_code.as_deref().and_then(ErrorCode::parse) {
            if c.is_config() && !codes.contains(&c) {
                codes.push(c);
            }
        }
    }
    codes
}

/// Background failures go to ~/.pama/pama.log (the desktop app has no visible stderr).
fn log_error(stage: &str, e: &dyn std::fmt::Display) {
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
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{now} desktop {stage} failed: {e}");
    }
}
