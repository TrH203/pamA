//! Cursor and OpenCode adapters (spec 005) over synthetic fixtures built from the documented
//! shapes: Cursor `agent-transcripts/*.jsonl` rows and OpenCode's session/message/part records,
//! both as legacy JSON files and in the 1.2+ SQLite database.

use std::path::PathBuf;

use pama_core::agents;
use pama_core::digest::Agent;
use pama_core::session::{cursor, opencode, EventKind};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

const CURSOR_ID: &str = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";

#[test]
fn cursor_lists_nested_and_flat_transcripts() {
    let found = cursor::transcripts(&fixtures().join("cursor/projects"));
    let ids: Vec<&str> = found.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, vec!["0a0b0c0d-1111-4222-8333-444455556666", CURSOR_ID]);
}

#[test]
fn cursor_transcript_becomes_normalized_events() {
    let f = fixtures().join(format!(
        "cursor/projects/Users-dev-work-shop/agent-transcripts/{CURSOR_ID}/{CURSOR_ID}.jsonl"
    ));
    let s = agents::by_id("cursor")
        .unwrap()
        .parse(&f.to_string_lossy())
        .unwrap();
    assert_eq!(s.meta.agent, Agent::Cursor);
    assert_eq!(s.meta.session_id, CURSOR_ID);
    assert_eq!(s.skipped_lines, 1);
    let kinds: Vec<EventKind> = s.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            EventKind::User,
            EventKind::Assistant,
            EventKind::ToolCall,
            EventKind::ToolCall,
            EventKind::ToolCall,
            EventKind::Assistant,
        ]
    );
    assert_eq!(s.events[2].tool.as_deref(), Some("read"));
    assert_eq!(s.events[2].path.as_deref(), Some("src/webhook.ts"));
    assert_eq!(s.events[3].tool.as_deref(), Some("edit"));
    assert!(s.events[3].text.contains("retry(() => handle(e), 3)"));
    assert_eq!(s.events[4].tool.as_deref(), Some("bash"));
    assert_eq!(s.events[4].command.as_deref(), Some("pnpm test webhook"));
    assert!(s.events.iter().all(|e| !e.text.contains("hidden")));
}

#[test]
fn cursor_slug_resolves_to_an_existing_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("my-app").join("web");
    std::fs::create_dir_all(&ws).unwrap();
    let real = ws.canonicalize().unwrap();
    let slug = real
        .to_string_lossy()
        .trim_start_matches('/')
        .replace('/', "-");
    assert_eq!(cursor::workspace_of_slug(&slug), Some(real));
    assert_eq!(
        cursor::workspace_of_slug("does-not-exist-anywhere-xyz"),
        None
    );
}

fn check_opencode(s: &pama_core::session::NormalizedSession) {
    assert_eq!(s.meta.agent, Agent::OpenCode);
    assert_eq!(s.meta.session_id, "ses_abc123");
    assert_eq!(s.meta.cwd.as_deref(), Some("/Users/dev/work/shop"));
    assert_eq!(s.meta.agent_version.as_deref(), Some("1.1.40"));
    let kinds: Vec<EventKind> = s.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            EventKind::User,
            EventKind::ToolCall,
            EventKind::ToolResult,
            EventKind::ToolCall,
            EventKind::ToolResult,
            EventKind::Assistant,
        ]
    );
    assert_eq!(s.events[1].command.as_deref(), Some("rg invalidate src"));
    assert_eq!(s.events[2].text, "src/cache.ts:12: invalidate(key)");
    assert_eq!(s.events[3].tool.as_deref(), Some("edit"));
    assert_eq!(
        s.events[3].path.as_deref(),
        Some("/Users/dev/work/shop/src/cache.ts")
    );
    let all: String = s.events.iter().map(|e| e.text.as_str()).collect();
    assert!(!all.contains("injected"), "synthetic parts are dropped");
    assert!(!all.contains("secret thoughts"), "reasoning is dropped");
    assert!(s.meta.started_at.as_deref().unwrap() < s.meta.ended_at.as_deref().unwrap());
}

#[test]
fn opencode_legacy_files_parse() {
    let data = fixtures().join("opencode");
    let found = opencode::sessions(&data);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "ses_abc123");
    assert_eq!(
        opencode::locate(&data, "ses_abc123").as_deref(),
        Some(found[0].location.as_str())
    );
    assert_eq!(opencode::session_id_of(&found[0].location), "ses_abc123");
    check_opencode(&opencode::parse(&found[0].location).unwrap());
}

/// Build an OpenCode 1.2-style database from the JSON fixtures (data blob = record minus ids).
#[test]
fn opencode_sqlite_parses_and_wins_over_legacy_copies() {
    let src = fixtures().join("opencode/storage");
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join(opencode::DB_FILE);
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch(
        "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
           version TEXT, time_created INTEGER, time_updated INTEGER);
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
    )
    .unwrap();
    let read = |p: PathBuf| -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    };
    let s = read(src.join("session/proj1/ses_abc123.json"));
    c.execute(
        "INSERT INTO session VALUES (?1, 'proj1', ?2, 'Cache', ?3, ?4, ?5)",
        rusqlite::params![
            "ses_abc123",
            s["directory"].as_str(),
            s["version"].as_str(),
            s["time"]["created"].as_i64(),
            s["time"]["updated"].as_i64()
        ],
    )
    .unwrap();
    for m in ["msg_001", "msg_002", "msg_003"] {
        let mut v = read(src.join(format!("message/ses_abc123/{m}.json")));
        v.as_object_mut().unwrap().remove("id");
        v.as_object_mut().unwrap().remove("sessionID");
        c.execute(
            "INSERT INTO message VALUES (?1, 'ses_abc123', 0, ?2)",
            rusqlite::params![m, v.to_string()],
        )
        .unwrap();
        for e in std::fs::read_dir(src.join("part").join(m)).unwrap() {
            let p = e.unwrap().path();
            let mut v = read(p.clone());
            let id = v["id"].as_str().unwrap().to_string();
            for k in ["id", "sessionID", "messageID"] {
                v.as_object_mut().unwrap().remove(k);
            }
            c.execute(
                "INSERT INTO part VALUES (?1, ?2, 'ses_abc123', ?3)",
                rusqlite::params![id, m, v.to_string()],
            )
            .unwrap();
        }
    }
    drop(c);
    // A leftover legacy copy of the same session next to the database.
    let legacy = dir.path().join("storage/session/proj1");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::copy(
        src.join("session/proj1/ses_abc123.json"),
        legacy.join("ses_abc123.json"),
    )
    .unwrap();

    let found = opencode::sessions(dir.path());
    assert_eq!(found.len(), 1, "database record wins");
    assert!(found[0].location.ends_with("opencode.db#ses_abc123"));
    assert_eq!(
        opencode::locate(dir.path(), "ses_abc123").as_deref(),
        Some(found[0].location.as_str()),
        "the hook finds the database record, not the legacy copy"
    );
    assert_eq!(opencode::locate(dir.path(), "ses_missing"), None);
    assert_eq!(opencode::locate(dir.path(), "../proj1/ses_abc123"), None);
    let s = agents::adapter(Agent::OpenCode)
        .parse(&found[0].location)
        .unwrap();
    check_opencode(&s);
}
