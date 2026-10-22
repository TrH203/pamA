//! Global hotkey (FR-019): capture the selection *before* our window takes focus, then show the
//! popup at the cursor and hand the captured question to it.

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::capture::{
    self,
    clipboard::{SystemClipboard, SystemKeyboard},
    CaptureResult, Method, RealClock,
};
use crate::state::{AppState, KEY_HOTKEY};
use crate::{popup, sidecar};

fn accessibility() -> Option<(String, Method, Option<String>)> {
    #[cfg(target_os = "macos")]
    return crate::capture::macos::selected_text().map(|(t, app)| (t, Method::Ax, app));
    #[cfg(target_os = "windows")]
    return crate::capture::windows::selected_text().map(|(t, app)| (t, Method::Uia, app));
    #[allow(unreachable_code)]
    None
}

pub fn capture_now() -> CaptureResult {
    match (SystemClipboard::new(), SystemKeyboard::new()) {
        (Some(mut cb), Some(mut kb)) => {
            capture::capture(accessibility, &mut cb, &mut kb, &mut RealClock)
        }
        _ => match accessibility() {
            Some((t, method, app)) => CaptureResult {
                text: Some(t),
                method,
                app,
            },
            None => CaptureResult {
                text: None,
                method: Method::None,
                app: None,
            },
        },
    }
}

pub fn on_hotkey<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let captured = capture_now();
        *app.state::<AppState>().last_capture.lock().unwrap() = Some(captured.clone());
        let cursor = app.cursor_position().unwrap_or_default();
        let info = match sidecar::ensure(&app) {
            Ok(i) => i,
            Err(e) => {
                let _ = app.emit(
                    "sidecar://state",
                    serde_json::json!({ "running": false, "error": e }),
                );
                return;
            }
        };
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(w) = popup::ensure(&handle, &info.url) {
                popup::show_at_cursor(&w, cursor);
                let _ = handle.emit_to(
                    popup::LABEL,
                    "hotkey://triggered",
                    serde_json::json!({ "captured": captured, "cursor": { "x": cursor.x, "y": cursor.y } }),
                );
            }
        });
    });
}

/// Register `accelerator`, replacing the current one. On failure the previous one stays.
pub fn set<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<(), String> {
    let new: Shortcut = accelerator.parse().map_err(|e| format!("{e}"))?;
    let gs = app.global_shortcut();
    let state = app.state::<AppState>();
    let old = state.hotkey.lock().unwrap().clone();
    let _ = gs.unregister_all();
    if let Err(e) = gs.register(new) {
        if let Ok(prev) = old.parse::<Shortcut>() {
            let _ = gs.register(prev);
        }
        return Err(e.to_string());
    }
    *state.hotkey.lock().unwrap() = accelerator.to_string();
    let _ = state
        .store
        .lock()
        .unwrap()
        .set_setting(KEY_HOTKEY, accelerator);
    Ok(())
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                on_hotkey(app);
            }
        })
        .build()
}
