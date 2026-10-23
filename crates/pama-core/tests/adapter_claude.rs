//! Claude Code adapter over anonymized fixtures (research R1).

use std::path::{Path, PathBuf};

use pama_core::digest::Agent;
use pama_core::session::{claude, EventKind};

const SID: &str = "7c1e2f30-0000-4a1b-9c2d-3e4f5a6b7c8d";

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude/2.1/-Users-dev-work-shop")
        .join(format!("{SID}.jsonl"))
}

#[test]
fn derives_transcript_path_from_cwd() {
    let p = claude::transcript_path(
        Path::new("/h/.claude/projects"),
        "/Users/dev/work/shop",
        SID,
    );
    assert_eq!(
        p,
        PathBuf::from(format!(
            "/h/.claude/projects/-Users-dev-work-shop/{SID}.jsonl"
        ))
    );
}

#[test]
fn parses_metadata() {
    let s = claude::parse(&fixture()).unwrap();
    assert_eq!(s.meta.agent, Agent::ClaudeCode);
    assert_eq!(s.meta.session_id, SID);
    assert_eq!(s.meta.cwd.as_deref(), Some("/Users/dev/work/shop"));
    assert_eq!(s.meta.git_branch.as_deref(), Some("feat/refund-shipping"));
    assert_eq!(s.meta.agent_version.as_deref(), Some("2.1.0"));
    assert!(s.meta.started_at.is_some() && s.meta.ended_at.is_some());
    assert_eq!(
        s.skipped_lines, 1,
        "the one malformed line is skipped, not fatal"
    );
}

#[test]
fn keeps_conversation_and_tools_but_ignores_noise() {
    let s = claude::parse(&fixture()).unwrap();
    let all: String = s
        .events
        .iter()
        .map(|e| e.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !all.contains("DUPLICATE CONTENT"),
        "api-request-blob records are ignored"
    );
    assert!(
        !all.contains("private reasoning"),
        "thinking blocks are not used"
    );
    assert!(!all.contains("/clear"), "meta user records are ignored");
    assert!(all.contains("Should refunds include the shipping fee?"));
    assert!(all.contains("refunds will NOT include the shipping fee"));
    assert!(
        all.contains("Subagent: carrier API docs"),
        "subagent transcripts are merged"
    );

    let read = s
        .events
        .iter()
        .find(|e| {
            e.kind == EventKind::ToolCall && e.path.as_deref().is_some_and(|p| p.ends_with(".env"))
        })
        .expect("Read .env tool call");
    assert_eq!(read.tool.as_deref(), Some("read"));
    let result = s
        .events
        .iter()
        .find(|e| e.kind == EventKind::ToolResult && e.call_id == read.call_id)
        .expect("result linked to the call");
    assert_eq!(result.tool.as_deref(), Some("read"));
    assert_eq!(result.path, read.path);

    let bash = s
        .events
        .iter()
        .find(|e| e.kind == EventKind::ToolCall && e.tool.as_deref() == Some("bash"))
        .unwrap();
    assert_eq!(bash.command.as_deref(), Some("env"));
}

fn branch_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude-branches")
        .join(format!("{name}.jsonl"))
}

#[test]
fn records_every_branch_in_visit_order() {
    let s = claude::parse(&branch_fixture("multi-branch")).unwrap();
    let names: Vec<_> = s.meta.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["main", "feat/login", "fix/typo"]);
    let counts: Vec<_> = s.meta.branches.iter().map(|b| b.events).collect();
    assert_eq!(counts, [2, 30, 5]);
    let login = &s.meta.branches[1];
    assert!(login.first_seen.as_deref() < login.last_seen.as_deref());
    assert!(
        s.meta.branches[0].first_seen.as_deref() < login.first_seen.as_deref(),
        "branches are ordered by first sight"
    );
    assert_eq!(
        s.meta.git_branch.as_deref(),
        Some("feat/login"),
        "filing branch"
    );
}

#[test]
fn returning_to_a_branch_keeps_one_entry() {
    let s = claude::parse(&branch_fixture("abab")).unwrap();
    let names: Vec<_> = s.meta.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["A", "B"]);
    assert_eq!(s.meta.branches[0].events, 6);
    assert_eq!(s.meta.branches[1].events, 4);
}

#[test]
fn main_only_and_tie_and_no_branch() {
    let s = claude::parse(&branch_fixture("main-only")).unwrap();
    assert_eq!(s.meta.git_branch.as_deref(), Some("main"));
    let s = claude::parse(&branch_fixture("tie")).unwrap();
    assert_eq!(s.meta.git_branch.as_deref(), Some("feat/a"));
    let s = claude::parse(&branch_fixture("no-branch")).unwrap();
    assert!(s.meta.branches.is_empty());
    assert_eq!(s.meta.git_branch, None);
}

#[test]
fn existing_fixture_has_a_single_branch() {
    let s = claude::parse(&fixture()).unwrap();
    assert_eq!(s.meta.branches.len(), 1);
    assert_eq!(s.meta.branches[0].name, "feat/refund-shipping");
}
