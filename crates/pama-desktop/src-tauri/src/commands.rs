//! Tauri commands (contracts/desktop-ipc.md). There is deliberately no command that sends a
//! message to another application (Constitution III).

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::capture::{
    self,
    clipboard::{SystemClipboard, SystemKeyboard},
    CaptureResult, RealClock,
};
use crate::state::AppState;
use crate::{hotkey, popup, sidecar};

type CmdResult<T> = Result<T, String>;

#[derive(Serialize)]
pub struct Ok {
    ok: bool,
}

#[tauri::command]
pub fn capture_selection(state: State<'_, AppState>) -> CaptureResult {
    // The popup has focus now, so re-capturing would read our own window: return what the
    // hotkey captured before the popup appeared.
    state
        .last_capture
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(hotkey::capture_now)
}

#[tauri::command]
pub async fn paste_draft<R: Runtime>(app: AppHandle<R>, text: String) -> CmdResult<Ok> {
    popup::hide_and_return_focus(&app);
    tauri::async_runtime::spawn_blocking(move || {
        // Let the previous app take focus back before pasting into it.
        std::thread::sleep(std::time::Duration::from_millis(200));
        let (Some(mut cb), Some(mut kb)) = (SystemClipboard::new(), SystemKeyboard::new()) else {
            return Ok { ok: false };
        };
        Ok {
            ok: capture::paste_draft(&mut cb, &mut kb, &mut RealClock, &text),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_draft(text: String) -> Ok {
    match SystemClipboard::new() {
        Some(mut cb) => {
            capture::copy_draft(&mut cb, &text);
            Ok { ok: true }
        }
        None => Ok { ok: false },
    }
}

#[tauri::command]
pub fn hide_popup<R: Runtime>(app: AppHandle<R>) {
    if let Some(w) = app.get_webview_window(popup::LABEL) {
        let _ = w.hide();
    }
}

#[derive(Serialize)]
pub struct Permissions {
    accessibility: &'static str,
}

#[tauri::command]
pub fn get_permissions() -> Permissions {
    #[cfg(target_os = "macos")]
    let accessibility = if crate::capture::macos::trusted() {
        "granted"
    } else {
        "denied"
    };
    #[cfg(not(target_os = "macos"))]
    let accessibility = "n/a";
    Permissions { accessibility }
}

pub fn open_url(url: &str) {
    let _ = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else if cfg!(windows) {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
}

#[tauri::command]
pub fn open_permission_settings() {
    #[cfg(target_os = "macos")]
    {
        crate::capture::macos::prompt_for_trust();
        open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    }
}

#[derive(Serialize)]
pub struct HotkeyResult {
    ok: bool,
    conflict: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn set_hotkey<R: Runtime>(app: AppHandle<R>, accelerator: String) -> HotkeyResult {
    match hotkey::set(&app, &accelerator) {
        Ok(()) => HotkeyResult {
            ok: true,
            conflict: false,
            error: None,
        },
        Err(e) => HotkeyResult {
            ok: false,
            conflict: true,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn sidecar_status<R: Runtime>(app: AppHandle<R>) -> sidecar::SidecarStatus {
    sidecar::status(&app)
}

/// Open the owner console in the browser (optionally on a tab, e.g. links with a question).
#[tauri::command]
pub fn open_console<R: Runtime>(app: AppHandle<R>, path: Option<String>) -> CmdResult<()> {
    let s = sidecar::status(&app);
    let (Some(url), Some(token)) = (s.url, s.token) else {
        return Err("the local server is not running".into());
    };
    open_url(&format!(
        "{url}{}#token={token}",
        path.unwrap_or_else(|| "/".into())
    ));
    Ok(())
}

// --- Settings (US4) ----------------------------------------------------------------------------

/// Settings the UI may change. Keys ending in `.key` are secrets and go to the OS keychain.
const SETTINGS: [&str; 9] = [
    "provider.chat.provider",
    "provider.chat.model",
    "provider.chat.base_url",
    "provider.small.model",
    "provider.embed.provider",
    "provider.embed.model",
    "provider.embed.base_url",
    "hotkey.answer_source",
    "sync.default_target",
];

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> serde_json::Map<String, serde_json::Value> {
    let store = state.store.lock().unwrap();
    let mut out = serde_json::Map::new();
    for k in SETTINGS.iter().chain(&[
        pama_core::client::KEY_STRICT_OFFLINE,
        pama_core::client::KEY_DECLARED_HOSTS,
    ]) {
        out.insert(
            (*k).into(),
            store
                .setting(k)
                .ok()
                .flatten()
                .map_or(serde_json::Value::Null, Into::into),
        );
    }
    for p in ["anthropic", "openai-compatible"] {
        let set = pama_core::secrets::get(&format!("provider.{p}.key"))
            .ok()
            .flatten()
            .is_some();
        out.insert(format!("provider.{p}.key"), serde_json::Value::Bool(set));
    }
    out.insert(
        "hotkey.accelerator".into(),
        state.hotkey.lock().unwrap().clone().into(),
    );
    out
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> CmdResult<Ok> {
    if key.starts_with("provider.") && key.ends_with(".key") {
        pama_core::secrets::set(&key, &value).map_err(|e| e.to_string())?;
        return Ok(Ok { ok: true });
    }
    if !SETTINGS.contains(&key.as_str()) {
        return Err(format!("unknown setting {key}"));
    }
    state
        .store
        .lock()
        .unwrap()
        .set_setting(&key, &value)
        .map_err(|e| e.to_string())?;
    Ok(Ok { ok: true })
}

#[tauri::command]
pub fn open_settings<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    crate::popup::open_settings(&app).map_err(|e| e.to_string())
}

// --- Sync and strict offline (US4) -------------------------------------------------------------

#[tauri::command]
pub fn set_sync<R: Runtime>(
    app: AppHandle<R>,
    scope: String,
    id: String,
    enabled: bool,
    target: Option<String>,
) -> CmdResult<Ok> {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    let path = match scope.as_str() {
        "project" => format!("/v1/projects/{id}"),
        "bundle" => format!("/v1/bundles/{id}"),
        _ => return Err("scope must be project or bundle".into()),
    };
    let target = target.or(store.setting("sync.default_target").ok().flatten());
    let mut body = serde_json::json!({ "sync_enabled": enabled });
    if enabled {
        body["sync_target"] = serde_json::json!(target);
    }
    let api = pama_core::client::LocalApi::connect(&store, "desktop").map_err(|e| e.to_string())?;
    api.patch(&path, "sync.toggle", &body)
        .map_err(|e| e.to_string())?;
    pama_core::sync::sync_once(&store).map_err(|e| e.to_string())?;
    Ok(Ok { ok: true })
}

#[tauri::command]
pub fn set_strict_offline(
    state: State<'_, AppState>,
    enabled: bool,
    declared_hosts: Vec<String>,
) -> CmdResult<Ok> {
    let store = state.store.lock().unwrap();
    store
        .set_setting(
            pama_core::client::KEY_STRICT_OFFLINE,
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())?;
    store
        .set_setting(
            pama_core::client::KEY_DECLARED_HOSTS,
            &declared_hosts.join(","),
        )
        .map_err(|e| e.to_string())?;
    Ok(Ok { ok: true })
}

#[tauri::command]
pub fn get_network_log(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> CmdResult<Vec<pama_core::store::NetworkLogEntry>> {
    state
        .store
        .lock()
        .unwrap()
        .network_log(limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}
