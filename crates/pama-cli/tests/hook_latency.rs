//! `pama hook claude` must only enqueue and return quickly (SessionEnd has a 1.5 s budget;
//! contracts/cli.md: < 200 ms). It must exit 0 even on bad input so it never breaks the agent.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

fn run_hook(home: &std::path::Path, stdin: &str) -> (std::process::ExitStatus, u128) {
    let start = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pama"))
        .args(["hook", "claude"])
        .env("PAMA_HOME", home)
        .env_remove("PAMA_SERVER_CMD")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let status = child.wait().unwrap();
    (status, start.elapsed().as_millis())
}

#[test]
fn hook_enqueues_fast_and_never_fails() {
    let home = std::env::temp_dir().join(format!("pama-hook-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    // Warm up (first exec pays dynamic loading costs).
    run_hook(&home, "{}");
    let input = r#"{"session_id":"s-lat","transcript_path":"/tmp/none.jsonl","cwd":"/tmp","hook_event_name":"SessionEnd","reason":"exit"}"#;
    let (status, ms) = run_hook(&home, input);
    assert!(status.success());
    assert!(ms < 200, "hook took {ms} ms");

    let store = pama_core::store::Store::open(&home.join("device.db")).unwrap();
    let c = store.captures(10).unwrap();
    assert!(c.iter().any(|c| c.agent_session_id == "s-lat"));

    let (bad, _) = run_hook(&home, "not json");
    assert!(bad.success(), "bad input must not fail the agent's hook");
    let _ = std::fs::remove_dir_all(home);
}
