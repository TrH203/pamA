//! Tray menu: open the console, start at login, quit.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

use crate::commands::open_console;
use crate::{hotkey, sidecar};

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let console = MenuItem::with_id(app, "console", "Open console", true, None::<&str>)?;
    let ask = MenuItem::with_id(app, "ask", "Draft an answer…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        autostart,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit pamA", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &console,
            &ask,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &login,
            &quit,
        ],
    )?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("pama")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("pamA")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "console" => {
                let _ = open_console(app.clone(), None);
            }
            "ask" => hotkey::on_hotkey(app),
            "settings" => {
                let _ = crate::popup::open_settings(app);
            }
            "autostart" => {
                let al = app.autolaunch();
                let _ = if al.is_enabled().unwrap_or(false) {
                    al.disable()
                } else {
                    al.enable()
                };
            }
            "quit" => {
                sidecar::stop_owned(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
