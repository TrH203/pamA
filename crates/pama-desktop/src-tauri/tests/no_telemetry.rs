//! FR-028 / Constitution I: no telemetry, no update checks without consent. The desktop config
//! must not enable the updater or point at any remote endpoint, and no telemetry crate is linked.

use std::path::Path;

fn read(p: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(p)).unwrap()
}

#[test]
fn updater_is_not_configured() {
    for f in ["tauri.conf.json", "tauri.release.conf.json"] {
        let conf: serde_json::Value = serde_json::from_str(&read(f)).unwrap();
        assert!(
            conf["plugins"]["updater"].is_null(),
            "{f}: updater must stay off by default"
        );
        assert!(conf["bundle"]["createUpdaterArtifacts"].is_null(), "{f}");
    }
}

#[test]
fn no_remote_endpoints_in_config() {
    for f in ["tauri.conf.json", "tauri.release.conf.json"] {
        let text = read(f);
        for (i, _) in text.match_indices("http") {
            let rest = &text[i..];
            assert!(
                rest.starts_with("http://127.0.0.1")
                    || rest.starts_with("http://ipc.localhost")
                    || rest.starts_with("https://schema.tauri.app"),
                "{f}: unexpected endpoint near {:?}",
                &rest[..rest.len().min(40)]
            );
        }
    }
}

#[test]
fn no_telemetry_or_updater_dependencies() {
    let manifest = read("Cargo.toml");
    for banned in [
        "tauri-plugin-updater",
        "sentry",
        "posthog",
        "segment",
        "telemetry",
        "analytics",
    ] {
        assert!(
            !manifest.contains(banned),
            "Cargo.toml must not depend on {banned}"
        );
    }
}
