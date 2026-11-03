//! While the app runs: pick up ended sessions the hooks missed (watcher fallback), digest queued
//! captures, and notify the owner about new drafts to review and forwarded questions.

use std::time::Duration;

use pama_core::capture::errors::{from_draft, notification_text, ErrorCode, NotifyGate};
use pama_core::capture::scan::scan;
use pama_core::capture::worker::{drain, Worker};
use pama_core::client::{Api, LocalApi};
use pama_core::redact::RuleSet;
use pama_core::remote::{self, Home, RemoteSink};
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
                if let Err(e) = scan(&store, Duration::from_secs(86_400), IDLE) {
                    log_error("scan", &e);
                }
                // Home decides where drafts go (spec 005): a server, or the local sidecar.
                let home = remote::home(&store);
                if let Home::Server(target) = &home {
                    drain_remote(&store, &rules, target);
                } else if let Err(e) = pama_core::sync::sync_once(&store) {
                    log_error("sync", &e);
                }
                if home != Home::Local {
                    // Remote mode: nothing to drain on the local server.
                } else if let Ok(api) = LocalApi::connect(&store, "desktop") {
                    let worker = Worker {
                        store: &store,
                        rules: &rules,
                        sink: api,
                    };
                    if let Err(e) = drain(&worker, &pama_core::paths::drain_lock()) {
                        log_error("drain", &e);
                    }
                }
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
                pama_core::secrets::init_platform_store();
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

/// Remote mode: draft on this machine, deliver to the home server, pull review decisions.
fn drain_remote(store: &pama_core::store::Store, rules: &RuleSet, target: &str) {
    pama_core::secrets::init_platform_store();
    match pama_core::draft::llm::HttpModel::new(store, "desktop") {
        Ok(model) => {
            let worker = Worker {
                store,
                rules,
                sink: RemoteSink {
                    store,
                    rules,
                    model: &model,
                    target: target.to_string(),
                },
            };
            if let Err(e) = drain(&worker, &pama_core::paths::drain_lock()) {
                log_error("drain", &e);
            }
        }
        Err(e) => {
            // No drafting model (missing key, provider down): record it on the due captures so
            // they back off, and a configuration error reaches the owner as a notification.
            let coded = match &e {
                pama_core::draft::DraftError::Retryable(m) => from_draft(true, m),
                pama_core::draft::DraftError::Fatal(m) => from_draft(false, m),
            };
            match store.fail_due(&coded) {
                Ok(0) => {}
                Ok(_) => log_error("drafting model", &e),
                Err(se) => log_error("drafting model", &se),
            }
        }
    }
    let http = pama_core::sync::HttpRemote::new(store);
    if let Err(e) = pama_core::sync::deliver_due(store, &http) {
        log_error("deliver", &e);
    }
    if let Ok(api) = Api::remote(store, "desktop", target) {
        if let Err(e) = remote::pull_changes(store, &api, false) {
            log_error("pull", &e);
        }
    }
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
