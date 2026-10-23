//! Shared desktop state.

use std::process::Child;
use std::sync::Mutex;

use pama_core::sidecar::ServerInfo;
use pama_core::store::Store;

use crate::capture::CaptureResult;

pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+Space";
pub const KEY_HOTKEY: &str = "hotkey.accelerator";

pub struct AppState {
    pub store: Mutex<Store>,
    pub server: Mutex<Option<ServerInfo>>,
    /// The server process, when this app started it (stopped on exit).
    pub child: Mutex<Option<Child>>,
    pub hotkey: Mutex<String>,
    pub last_capture: Mutex<Option<CaptureResult>>,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        let hotkey = store
            .setting(KEY_HOTKEY)
            .ok()
            .flatten()
            .unwrap_or_else(|| DEFAULT_HOTKEY.to_string());
        Self {
            store: Mutex::new(store),
            server: Mutex::new(None),
            child: Mutex::new(None),
            hotkey: Mutex::new(hotkey),
            last_capture: Mutex::new(None),
        }
    }
}
