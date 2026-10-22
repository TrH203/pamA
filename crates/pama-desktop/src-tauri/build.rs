// App commands are listed so capabilities can grant them one by one (least privilege).
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "capture_selection",
            "paste_draft",
            "copy_draft",
            "hide_popup",
            "get_permissions",
            "open_permission_settings",
            "set_hotkey",
            "sidecar_status",
            "open_console",
            "set_sync",
            "set_strict_offline",
            "get_network_log",
            "get_settings",
            "set_setting",
            "open_settings",
        ]),
    ))
    .expect("tauri build");
}
