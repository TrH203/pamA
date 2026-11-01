//! While the app runs: pick up ended sessions the hooks missed (watcher fallback), digest queued
//! captures, and notify the owner about new drafts to review and forwarded questions.

use std::time::Duration;

use pama_core::capture::scan::scan;
use pama_core::capture::worker::{drain, Worker};
use pama_core::client::{Api, LocalApi};
use pama_core::remote::{self, Home, RemoteSink};
use pama_core::redact::RuleSet;
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
            if !store.due_captures(1).unwrap_or_default().is_empty() {
                log_error("drafting model", &e);
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
