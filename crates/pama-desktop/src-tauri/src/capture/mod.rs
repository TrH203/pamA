//! Selection capture and paste, platform-independent (research R8, Constitution III):
//! - capture: snapshot the clipboard, simulate copy, poll for the selection (≤ 300 ms), restore;
//! - paste: put the draft on the clipboard, simulate paste, restore the previous clipboard after
//!   500 ms. Never presses Enter, never sends anything.
//!
//! The OS clipboard and keyboard sit behind traits so this logic is tested without a desktop.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

pub mod clipboard;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

/// How long to wait for the copied selection to show up.
pub const CAPTURE_TIMEOUT: Duration = Duration::from_millis(300);
pub const POLL: Duration = Duration::from_millis(10);
/// The target app reads the clipboard asynchronously after Cmd/Ctrl+V.
pub const RESTORE_AFTER_PASTE: Duration = Duration::from_millis(500);

/// What was on the clipboard, in the richest form we can put back (one format; exotic and
/// app-private formats cannot be restored — documented limitation).
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Snapshot {
    #[default]
    Empty,
    Text(String),
    Html {
        html: String,
        alt: Option<String>,
    },
    Image {
        width: usize,
        height: usize,
        rgba: Vec<u8>,
    },
    Files(Vec<PathBuf>),
}

pub trait Clipboard {
    fn snapshot(&mut self) -> Snapshot;
    fn restore(&mut self, s: &Snapshot);
    fn clear(&mut self);
    fn text(&mut self) -> Option<String>;
    fn set_text(&mut self, text: &str);
}

pub trait Keyboard {
    /// Cmd+C / Ctrl+C in the focused app.
    fn copy(&mut self) -> bool;
    /// Cmd+V / Ctrl+V in the focused app.
    fn paste(&mut self) -> bool;
}

pub trait Clock {
    fn sleep(&mut self, d: Duration);
}

pub struct RealClock;

impl Clock for RealClock {
    fn sleep(&mut self, d: Duration) {
        std::thread::sleep(d);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    /// macOS Accessibility (AXSelectedText).
    Ax,
    /// Windows UI Automation.
    Uia,
    Clipboard,
    None,
}

/// Only the captured question leaves this module; nothing else from the clipboard is kept.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaptureResult {
    pub text: Option<String>,
    pub method: Method,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
}

fn clean(s: String) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.chars().take(2_000).collect())
}

/// Copy the selection through the clipboard and put the previous clipboard back.
pub fn capture_via_clipboard(
    cb: &mut impl Clipboard,
    kb: &mut impl Keyboard,
    clock: &mut impl Clock,
) -> Option<String> {
    let snap = cb.snapshot();
    cb.clear();
    let mut text = None;
    if kb.copy() {
        let mut waited = Duration::ZERO;
        while waited < CAPTURE_TIMEOUT {
            clock.sleep(POLL);
            waited += POLL;
            if let Some(t) = cb.text().and_then(clean) {
                text = Some(t);
                break;
            }
        }
    }
    cb.restore(&snap);
    text
}

/// Accessibility first (no clipboard involved), clipboard fallback.
pub fn capture(
    accessibility: impl FnOnce() -> Option<(String, Method, Option<String>)>,
    cb: &mut impl Clipboard,
    kb: &mut impl Keyboard,
    clock: &mut impl Clock,
) -> CaptureResult {
    if let Some((t, method, app)) = accessibility() {
        if let Some(text) = clean(t) {
            return CaptureResult {
                text: Some(text),
                method,
                app,
            };
        }
    }
    match capture_via_clipboard(cb, kb, clock) {
        Some(text) => CaptureResult {
            text: Some(text),
            method: Method::Clipboard,
            app: None,
        },
        None => CaptureResult {
            text: None,
            method: Method::None,
            app: None,
        },
    }
}

/// Paste the draft into the focused app, then restore what the owner had copied.
pub fn paste_draft(
    cb: &mut impl Clipboard,
    kb: &mut impl Keyboard,
    clock: &mut impl Clock,
    draft: &str,
) -> bool {
    let snap = cb.snapshot();
    cb.set_text(draft);
    let ok = kb.paste();
    clock.sleep(RESTORE_AFTER_PASTE);
    cb.restore(&snap);
    ok
}

/// The owner chose "Copy": the draft stays on the clipboard.
pub fn copy_draft(cb: &mut impl Clipboard, draft: &str) {
    cb.set_text(draft);
}
