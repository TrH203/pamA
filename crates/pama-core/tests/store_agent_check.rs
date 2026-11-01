//! Device stores created before spec 005 only allowed Claude Code and Codex captures: opening
//! one widens the CHECK and keeps every row.

use pama_core::digest::Agent;
use pama_core::store::{NewCapture, Store};

#[test]
fn old_store_is_widened_without_losing_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("device.db");
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        let old = include_str!("../src/store/schema.sql").replace(
            "('claude_code', 'codex', 'cursor', 'opencode')",
            "('claude_code', 'codex')",
        );
        c.execute_batch(&old).unwrap();
        c.execute(
            "INSERT INTO captured_session (id, agent, agent_session_id, transcript_path, status, ended_at)
             VALUES ('c1', 'codex', 's1', '/t', 'detected', 1)",
            [],
        )
        .unwrap();
        assert!(c
            .execute(
                "INSERT INTO captured_session (id, agent, agent_session_id, transcript_path, status, ended_at)
                 VALUES ('c2', 'cursor', 's2', '/t', 'detected', 1)",
                [],
            )
            .is_err());
    }
    let s = Store::open(&path).unwrap();
    assert_eq!(s.captures(10).unwrap().len(), 1);
    for agent in [Agent::Cursor, Agent::OpenCode] {
        s.enqueue_capture(
            &NewCapture {
                agent,
                agent_session_id: format!("s-{}", agent.as_str()),
                transcript_path: "/t".into(),
                cwd: None,
                reason: None,
            },
            0,
        )
        .unwrap();
    }
    let agents: Vec<Agent> = s.captures(10).unwrap().iter().map(|c| c.agent).collect();
    assert_eq!(agents.len(), 3);
    assert!(agents.contains(&Agent::OpenCode));
    drop(s);
    // Opening again is a no-op.
    assert_eq!(Store::open(&path).unwrap().captures(10).unwrap().len(), 3);
}
