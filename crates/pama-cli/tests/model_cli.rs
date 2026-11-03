//! `pama model` argument handling (specs/003-model-settings/contracts/cli.md). No server needed.

use std::process::Command;

fn temp_home(name: &str) -> std::path::PathBuf {
    let h = std::env::temp_dir().join(format!("pama-model-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&h).unwrap();
    h
}

fn pama(home: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_pama"))
        .args(args)
        .env("PAMA_HOME", home)
        .output()
        .unwrap()
}

#[test]
fn rejects_unknown_roles_and_providers() {
    let home = temp_home("t");
    for args in [
        vec![
            "model",
            "set",
            "bogus",
            "--provider",
            "ollama",
            "--model",
            "m",
        ],
        vec![
            "model",
            "set",
            "chat",
            "--provider",
            "bogus",
            "--model",
            "m",
        ],
        vec!["model", "revert", "bogus"],
    ] {
        let out = pama(&home, &args);
        assert!(!out.status.success(), "{args:?} should fail");
        assert_eq!(out.status.code(), Some(2), "clap usage error: {args:?}");
    }
}

#[test]
fn lists_model_subcommands() {
    let home = temp_home("t");
    let out = pama(&home, &["model", "--help"]);
    let text = String::from_utf8_lossy(&out.stdout);
    for c in ["show", "set", "switch", "check", "revert", "setup"] {
        assert!(text.contains(c), "missing {c}");
    }
}

#[test]
fn reports_when_the_server_is_not_running() {
    let home = temp_home("t");
    let out = pama(&home, &["model", "show"]);
    assert_eq!(out.status.code(), Some(3));
}

/// A one-thread HTTP server: `/v1/models/check` answers chat and refuses the operator's roles
/// with 403 (a cloud server before 0.2.1); anything else gets `{}`.
fn old_cloud_server() -> String {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap_or_default();
            let path = line.split(' ').nth(1).unwrap_or_default().to_string();
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; len];
            reader.read_exact(&mut body).unwrap_or_default();
            let body = String::from_utf8_lossy(&body);
            let (status, out) = if path == "/v1/models/check" && !body.contains("\"chat\"") {
                (
                    "403 Forbidden",
                    r#"{"error":{"code":"forbidden","message":"Only the server operator checks this model."}}"#,
                )
            } else if path == "/v1/models/check" {
                (
                    "200 OK",
                    r#"{"role":"chat","ok":true,"latencyMs":5,"items":[]}"#,
                )
            } else {
                ("200 OK", "{}")
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                out.len()
            );
        }
    });
    url
}

#[test]
fn model_check_on_a_cloud_server_reports_operator_roles_instead_of_failing() {
    let dir = tempfile::tempdir().unwrap();
    let url = old_cloud_server();
    let secrets = dir.path().join("secrets.json");
    std::fs::write(&secrets, format!(r#"{{"device-token:{url}":"pd_test"}}"#)).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_pama"))
        .args(["--json", "--server", &url, "model", "check"])
        .env("HOME", dir.path())
        .env("PAMA_HOME", dir.path().join("pama"))
        .env("PAMA_SECRETS_FILE", &secrets)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        out.status.code(),
        Some(0),
        "stdout: {stdout}\nstderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["chat"]["ok"], true);
    assert_eq!(v["small"]["operator_only"], true);
    assert_eq!(v["embed"]["operator_only"], true);
}
