//! pamA desktop: tray app with a global hotkey that drafts answers into any chat app, and the
//! local server that runs the pipeline on the owner's machine.

pub mod capture;

#[cfg(desktop)]
mod background;
#[cfg(desktop)]
mod commands;
#[cfg(desktop)]
mod hotkey;
#[cfg(desktop)]
mod popup;
#[cfg(desktop)]
mod resources;
#[cfg(desktop)]
mod sidecar;
#[cfg(desktop)]
mod state;
#[cfg(desktop)]
mod tray;

#[cfg(desktop)]
pub fn run() {
    use tauri::Manager;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    pama_core::secrets::init_platform_store();
    let store =
        pama_core::store::Store::open(&pama_core::paths::device_db()).expect("device store");

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(hotkey::plugin())
        .manage(state::AppState::new(store))
        .invoke_handler(tauri::generate_handler![
            commands::capture_selection,
            commands::paste_draft,
            commands::copy_draft,
            commands::hide_popup,
            commands::get_permissions,
            commands::open_permission_settings,
            commands::set_hotkey,
            commands::sidecar_status,
            commands::open_console,
            commands::set_sync,
            commands::set_strict_offline,
            commands::get_network_log,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            tray::create(&handle)?;
            let accel = app
                .state::<state::AppState>()
                .hotkey
                .lock()
                .unwrap()
                .clone();
            if let Err(e) = handle.global_shortcut().register(accel.as_str()) {
                eprintln!("pama: hotkey {accel} is taken: {e}");
            }
            #[cfg(target_os = "macos")]
            if !capture::macos::trusted() {
                capture::macos::prompt_for_trust();
            }
            sidecar::start_in_background(handle.clone(), |app, info| {
                let app2 = app.clone();
                let url = info.url.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = popup::ensure(&app2, &url);
                });
                background::start(app.clone());
            });
            Ok(())
        })
        .on_window_event(|w, event| {
            // Closing the popup only hides it; the app lives in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("pama desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::stop_owned(app);
            }
        });
}
