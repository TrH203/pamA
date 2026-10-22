//! The draft popup: a small always-on-top window served by the local server (`/desktop`).

use tauri::{
    AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const LABEL: &str = "popup";
const WIDTH: f64 = 440.0;
const HEIGHT: f64 = 460.0;

pub fn ensure<R: Runtime>(app: &AppHandle<R>, server_url: &str) -> tauri::Result<WebviewWindow<R>> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    let url: tauri::Url = format!("{server_url}/desktop").parse().expect("server url");
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("pamA")
        .inner_size(WIDTH, HEIGHT)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .resizable(true)
        .build()
}

/// Show next to the cursor, kept inside the monitor.
pub fn show_at_cursor<R: Runtime>(w: &WebviewWindow<R>, cursor: PhysicalPosition<f64>) {
    if let Ok(Some(m)) = w.current_monitor() {
        let scale = m.scale_factor();
        let (mw, mh) = (m.size().width as f64, m.size().height as f64);
        let (mx, my) = (m.position().x as f64, m.position().y as f64);
        let (ww, wh) = (WIDTH * scale, HEIGHT * scale);
        let x = (cursor.x + 12.0).min(mx + mw - ww).max(mx);
        let y = (cursor.y + 12.0).min(my + mh - wh).max(my);
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    let _ = w.show();
    let _ = w.set_focus();
}

/// Hide the popup and give focus back to the app the owner was in.
pub fn hide_and_return_focus<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.hide();
}
