//! Codex CLI adapter over anonymized rollout fixtures (research R2).

use std::path::PathBuf;

use pama_core::digest::Agent;
use pama_core::session::{codex, EventKind};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "tests/fixtures/codex/0.80/rollout-2026-10-21T10-00-00-0199aa11-2222-7333-8444-555566667777.jsonl",
    )
}

#[test]
fn parses_metadata_from_session_meta() {
    let s = codex::parse(&fixture()).unwrap();
    assert_eq!(s.meta.agent, Agent::Codex);
    assert_eq!(s.meta.session_id, "0199aa11-2222-7333-8444-555566667777");
    assert_eq!(s.meta.cwd.as_deref(), Some("/Users/dev/work/shop"));
    assert_eq!(
        s.meta.git_branch.as_deref(),
        Some("fix/flaky-checkout-test")
    );
    assert_eq!(
        s.meta.repo_url.as_deref(),
        Some("git@github.com:acme/shop.git")
    );
    assert_eq!(
        s.meta.git_commit.as_deref(),
        Some("4f1c2d9e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d")
    );
    assert_eq!(s.meta.agent_version.as_deref(), Some("0.80.0"));
}

#[test]
fn normalizes_events() {
    let s = codex::parse(&fixture()).unwrap();
    let users: Vec<_> = s
        .events
        .iter()
        .filter(|e| e.kind == EventKind::User)
        .collect();
    assert_eq!(
        users.len(),
        1,
        "environment context and event_msg duplicates are skipped"
    );
    assert_eq!(users[0].text, "The checkout test is flaky, fix it.");
    assert!(s.events.iter().all(|e| !e.text.contains("encrypted")));

    let cat = s
        .events
        .iter()
        .find(|e| e.kind == EventKind::ToolCall && e.command.as_deref() == Some("cat .env.test"))
        .expect("shell call unwrapped from bash -lc");
    assert_eq!(cat.tool.as_deref(), Some("bash"));
    let out = s
        .events
        .iter()
        .find(|e| e.kind == EventKind::ToolResult && e.call_id == cat.call_id)
        .unwrap();
    assert_eq!(
        out.text, "TEST_DB_PASSWORD=hunter2hunter2\n",
        "JSON output envelope unwrapped"
    );
    assert_eq!(out.command, cat.command);

    assert!(s
        .events
        .iter()
        .any(|e| e.kind == EventKind::ToolCall && e.tool.as_deref() == Some("apply_patch")));
    assert!(s
        .events
        .iter()
        .any(|e| e.kind == EventKind::Assistant && e.text.contains("explicit readiness signal")));
}
