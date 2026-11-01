//! Spec 005 commands end to end, without a server: `pama keys`, `pama server list|use`,
//! `pama use`, `pama agents`, the deprecated aliases and Codex notify chaining. Every test runs
//! in its own HOME/PAMA_HOME with secrets in a file (never the real keychain).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use pama_core::remote;
use pama_core::store::Store;
use serde_json::Value;

struct Env {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("home")).unwrap();
        Self { _dir: dir, root }
    }
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    fn pama_home(&self) -> PathBuf {
        self.root.join("pama")
    }
    fn store(&self) -> Store {
        Store::open(&self.pama_home().join("device.db")).unwrap()
    }
    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_pama"));
        c.args(args)
            .env("HOME", self.home())
            .env("PAMA_HOME", self.pama_home())
            .env("PAMA_SECRETS_FILE", self.root.join("secrets.json"))
            .env_remove("CODEX_HOME")
            .env_remove("CURSOR_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME")
            .env_remove("OPENCODE_DATA_DIR")
            .env_remove("PAMA_CLOUD_URL")
            .stdin(Stdio::null());
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().unwrap()
    }
    fn run_stdin(&self, args: &[&str], input: &str) -> Output {
        let mut child = self
            .cmd(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }
    fn json(&self, args: &[&str]) -> Value {
        let mut a = vec!["--json"];
        a.extend_from_slice(args);
        let out = self.run(&a);
        serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
            panic!(
                "{args:?}: {e}\nstdout: {}\nstderr: {}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )
        })
    }
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

#[test]
fn keys_are_set_from_stdin_listed_without_values_and_removed() {
    let e = Env::new();
    let out = e.run_stdin(&["keys", "set", "openrouter"], "sk-or-secret-123\n");
    assert!(out.status.success(), "{}", text(&out));
    let v = e.json(&["keys", "list"]);
    let raw = v.to_string();
    assert!(
        !raw.contains("sk-or-secret-123"),
        "values are never printed"
    );
    let row = v["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["provider"] == "openrouter")
        .unwrap();
    assert_eq!(row["stored"], true);
    assert!(row["where"].as_str().unwrap().contains("PAMA_SECRETS_FILE"));
    // Stored under the same name the drafting model reads.
    let secrets = std::fs::read_to_string(e.root.join("secrets.json")).unwrap();
    assert!(secrets.contains("provider.openrouter.key"));
    // Unknown providers are a usage error; an empty key is refused.
    assert_eq!(e.run(&["keys", "set", "bogus"]).status.code(), Some(2));
    assert!(!e
        .run_stdin(&["keys", "set", "openai"], "\n")
        .status
        .success());
    // Testing without a key is a config error, before any network call.
    assert_eq!(e.run(&["keys", "test", "anthropic"]).status.code(), Some(2));
    let out = e.run(&["keys", "remove", "openrouter"]);
    assert!(out.status.success());
    let v = e.json(&["keys", "list"]);
    assert!(v["keys"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["stored"] == false));
}

#[test]
fn paired_server_is_listed_and_home_switches_consistently() {
    let e = Env::new();
    // State left by an older `pama pair`: a default target missing from the server list.
    let url = "http://127.0.0.1:9";
    e.store()
        .set_setting(remote::KEY_DEFAULT_TARGET, url)
        .unwrap();
    let v = e.json(&["server", "list"]);
    assert_eq!(v["servers"][0]["url"], url);
    assert_eq!(v["servers"][0]["default"], true);
    assert_eq!(v["home"]["kind"], "local");

    // Not connected: refused with a hint.
    let out = e.run(&["use", "https://other.example", "--yes"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out).contains("pama connect https://other.example"));
    assert_eq!(
        e.run(&["server", "use", "https://other.example"])
            .status
            .code(),
        Some(2)
    );

    // Without --yes and without a terminal: preview only, nothing changes.
    let out = e.run(&["use", url]);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out).contains("only drafts digests"));
    assert_eq!(remote::home(&e.store()), remote::Home::Local);

    let v = e.json(&["use", url, "--yes"]);
    assert_eq!(v["changed"], true);
    let s = e.store();
    assert_eq!(remote::home(&s), remote::Home::Server(url.into()));
    assert_eq!(remote::mode(&s), remote::Mode::Remote);
    assert_eq!(remote::default_server(&s).as_deref(), Some(url));
    drop(s);

    let v = e.json(&["use", "local", "--yes"]);
    assert_eq!(v["home"]["kind"], "local");
    assert_eq!(remote::mode(&e.store()), remote::Mode::Local);
    // The server stays connected (sync target) after moving home back.
    assert_eq!(e.json(&["server", "list"])["servers"][0]["url"], url);

    // Forget: best-effort revoke (unreachable), then gone everywhere.
    let out = e.run(&["server", "forget", url]);
    assert!(out.status.success(), "{}", text(&out));
    let s = e.store();
    assert!(remote::servers(&s).is_empty());
    assert_eq!(remote::default_server(&s), None);
}

#[test]
fn deprecated_aliases_point_to_connect() {
    let e = Env::new();
    let out = e.run(&["login"]);
    assert!(text(&out).contains("deprecated; use `pama connect <url>`"));
    let out = e.run(&["connect"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out).contains("which server?"));
    let help = text(&e.run(&["--help"]));
    assert!(help.contains("connect") && help.contains("agents") && help.contains("keys"));
    assert!(!help.contains("\n  pair "), "pair is hidden");
}

fn read_json(p: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn agents_enable_list_disable_and_uninstall() {
    let e = Env::new();
    let proj = e.root.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let p = proj.to_string_lossy().to_string();

    let v = e.json(&["agents", "enable", "cursor", "--project", &p]);
    assert!(v["changes"].to_string().contains("hook added"));
    let hooks = read_json(&proj.join(".cursor/hooks.json"));
    assert!(hooks["hooks"]["stop"][0]["command"]
        .as_str()
        .unwrap()
        .ends_with("hook cursor"));

    e.json(&["agents", "enable", "claude", "--project", &p, "--shared"]);
    assert!(proj.join(".claude/settings.json").exists());

    let v = e.json(&["agents"]);
    let row = |id: &str| -> Value {
        v["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(row("cursor")["enabled"], true);
    assert!(row("cursor")["hooks"][0]["scope"]
        .as_str()
        .unwrap()
        .starts_with("project"));
    assert!(row("claude")["hooks"][0]["scope"]
        .as_str()
        .unwrap()
        .contains("(shared)"));

    // Doctor sees the project-scope (shared) hook.
    let out = e.run(&["--json", "doctor"]);
    let checks: Value = serde_json::from_slice(&out.stdout).unwrap();
    let claude = checks
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["check"] == "claude code hook")
        .unwrap();
    assert_eq!(claude["ok"], true, "{claude}");

    e.json(&["agents", "disable", "cursor"]);
    assert_eq!(
        e.json(&["agents"])["agents"][2]["enabled"],
        false,
        "cursor is third"
    );
    // A disabled agent's hook is ignored: nothing is queued.
    let out = e.run_stdin(
        &["hook", "cursor"],
        r#"{"conversation_id":"c1","transcript_path":"/nope.jsonl","hook_event_name":"stop"}"#,
    );
    assert!(out.status.success());
    assert!(e.store().captures(10).unwrap().is_empty());

    let v = e.json(&["agents", "uninstall", "cursor"]);
    assert_eq!(v["removed"].as_array().unwrap().len(), 1);
    let hooks = read_json(&proj.join(".cursor/hooks.json"));
    assert!(hooks["hooks"].get("stop").is_none());
    assert_eq!(
        e.json(&["agents", "uninstall", "cursor"])["removed"],
        serde_json::json!([])
    );
    assert_eq!(
        e.run(&["agents", "enable", "windsurf"]).status.code(),
        Some(1)
    );
}

#[test]
fn codex_notify_chains_an_existing_notifier() {
    let e = Env::new();
    let codex = e.home().join(".codex");
    std::fs::create_dir_all(&codex).unwrap();
    let marker = e.root.join("chained.txt");
    let script = e.root.join("notifier.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho \"$@\" > '{}'\n", marker.display()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let cfg = codex.join("config.toml");
    std::fs::write(
        &cfg,
        format!("notify = [\"{}\", \"x\"]\n", script.display()),
    )
    .unwrap();
    e.json(&["agents", "enable", "codex", "--global"]);
    let text = std::fs::read_to_string(&cfg).unwrap();
    assert!(text.contains("\"hook\", \"codex\", \"--chain\""), "{text}");

    // Codex calls: <pama> hook codex --chain <script> x <json>
    let out = e.run(&[
        "hook",
        "codex",
        "--chain",
        &script.to_string_lossy(),
        "x",
        r#"{"type":"agent-turn-complete","thread-id":"t"}"#,
    ]);
    assert!(out.status.success());
    for _ in 0..50 {
        if marker.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let got = std::fs::read_to_string(&marker).unwrap();
    assert!(
        got.starts_with("x {\"type\":\"agent-turn-complete\""),
        "{got}"
    );

    e.json(&["agents", "uninstall", "codex"]);
    assert_eq!(
        std::fs::read_to_string(&cfg).unwrap(),
        format!("notify = [\"{}\", \"x\"]\n", script.display())
    );
}
