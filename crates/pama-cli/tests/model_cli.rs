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
