//! While the app runs: pick up ended sessions the hooks missed (watcher fallback), digest queued
//! captures, and notify the owner about new drafts to review and forwarded questions.

use std::time::Duration;

use pama_core::capture::scan::{default_dirs, scan};
use pama_core::capture::worker::{drain, Worker};
use pama_core::client::LocalApi;
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
        let (claude, codex) = default_dirs();
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
                let _ = scan(
                    &store,
                    claude.as_deref(),
                    codex.as_deref(),
                    Duration::from_secs(86_400),
                    IDLE,
                );
                let _ = pama_core::sync::sync_once(&store);
                if let Ok(api) = LocalApi::connect(&store, "desktop") {
                    let worker = Worker {
                        store: &store,
                        rules: &rules,
                        sink: api,
                    };
                    let _ = drain(&worker, &pama_core::paths::drain_lock());
                }
                if let Ok(api) = LocalApi::connect(&store, "desktop") {
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
