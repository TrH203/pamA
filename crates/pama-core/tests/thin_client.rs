//! Thin client (spec 004) on the device: a captured session is drafted on this machine, only the
//! digest is queued for the remote server, delivery goes to `/v1/sync/drafts` with the device
//! token, and review decisions are pulled back into the device copy. A tiny HTTP server stands in
//! for the pamA server.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pama_core::capture::worker::{CaptureOutcome, Worker};
use pama_core::capture::KEY_CAPTURE_ALL;
use pama_core::client::Api;
use pama_core::draft::llm::DraftModel;
use pama_core::draft::DraftError;
use pama_core::redact::RuleSet;
use pama_core::remote::{self, RemoteSink};
use pama_core::store::{Agent, CaptureStatus, NewCapture, Store};
use pama_core::sync::{deliver_due, token_key, HttpRemote};
use serde_json::{json, Value};

const SESSION: &str = "7c1e2f30-0000-4a1b-9c2d-3e4f5a6b7c8d";

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixture() -> String {
    root()
        .join(format!(
            "tests/fixtures/claude/2.1/-Users-dev-work-shop/{SESSION}.jsonl"
        ))
        .to_string_lossy()
        .into_owned()
}

struct Canned;
impl DraftModel for Canned {
    fn id(&self) -> String {
        "canned".into()
    }
    fn complete(&self, _: &str, user: &str, _: &Value) -> Result<Value, DraftError> {
        assert!(user.contains("<transcript>"));
        Ok(json!({
            "goal": "Decide whether refunds include the shipping fee.",
            "decisions": [{ "what": "Refunds exclude shipping.", "why": "Carrier fee is non-refundable." }],
            "outcome": "Done.",
        }))
    }
}

/// (path, authorization header, body) of each request the mock server received.
type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

/// Answers `/v1/sync/drafts` and `/v1/sync/changes`; records (path, auth, body) of each request.
fn mock_server() -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
            let (mut len, mut auth) = (0usize, String::new());
            loop {
                let mut h = String::new();
                reader.read_line(&mut h).unwrap();
                if h == "\r\n" || h.is_empty() {
                    break;
                }
                let lower = h.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                if lower.starts_with("authorization:") {
                    auth = h["authorization:".len()..].trim().to_string();
                }
            }
            let mut body = vec![0; len];
            reader.read_exact(&mut body).unwrap();
            log.lock()
                .unwrap()
                .push((path.clone(), auth, String::from_utf8_lossy(&body).into()));
            let reply = if path.starts_with("/v1/sync/drafts") {
                json!({ "digest_id": "srv-1", "version": 1, "status": "draft" })
            } else if path.starts_with("/v1/sync/changes") && !path.contains("since=") {
                json!({
                    "changes": [{
                        "agent": "claude_code", "agent_session_id": SESSION,
                        "project_key": "k", "digest_id": "srv-2", "version": 2,
                        "status": "approved", "digest": { "goal": "Edited on the server." },
                    }],
                    "cursor": "7",
                })
            } else {
                json!({ "changes": [], "cursor": "7" })
            };
            let text = reply.to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            )
            .unwrap();
        }
    });
    (url, seen)
}

fn setup() -> (Store, RuleSet) {
    pama_core::secrets::use_mock_store();
    let store = Store::open_in_memory().unwrap();
    store.set_setting(KEY_CAPTURE_ALL, "true").unwrap();
    store
        .enqueue_capture(
            &NewCapture {
                agent: Agent::ClaudeCode,
                agent_session_id: SESSION.into(),
                transcript_path: fixture(),
                cwd: Some("/Users/dev/work/shop".into()),
                reason: None,
            },
            0,
        )
        .unwrap();
    let rules = RuleSet::load_dir(&root().join("../../rules")).unwrap();
    (store, rules)
}

fn project_key() -> String {
    let s = pama_core::session::claude::parse(std::path::Path::new(&fixture())).unwrap();
    pama_core::project::resolve(s.meta.cwd.as_deref(), s.meta.repo_url.as_deref()).key
}

#[test]
fn sessions_of_projects_without_sync_are_skipped_and_nothing_is_queued() {
    let (store, rules) = setup();
    let sink = RemoteSink {
        store: &store,
        rules: &rules,
        model: &Canned,
        target: "https://pama.example".into(),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink,
    };
    let out = w.run_due().unwrap();
    assert_eq!(out[0].1, CaptureOutcome::Skipped);
    assert_eq!(
        store.captures(10).unwrap()[0].status,
        CaptureStatus::Skipped
    );
    assert_eq!(store.outbox_counts().unwrap().pending, 0);
}

#[test]
fn drafts_on_device_deliver_to_the_server_and_pull_back_decisions() {
    let (store, rules) = setup();
    let (url, seen) = mock_server();
    pama_core::secrets::set(
        &token_key(&url),
        "pd_AAAAAAAA_secret-device-token-0123456789",
    )
    .unwrap();
    remote::add_server(
        &store,
        remote::ServerEntry {
            url: url.clone(),
            workspace_id: Some("w".into()),
            device_id: Some("d".into()),
        },
    )
    .unwrap();
    remote::set_mode(&store, remote::Mode::Remote).unwrap();
    remote::set_project_sync(&store, &project_key(), true).unwrap();

    let w = Worker {
        store: &store,
        rules: &rules,
        sink: RemoteSink {
            store: &store,
            rules: &rules,
            model: &Canned,
            target: url.clone(),
        },
    };
    let out = w.run_due().unwrap();
    assert!(
        matches!(out[0].1, CaptureOutcome::Submitted { .. }),
        "{:?}",
        out[0].1
    );
    let copy = store
        .remote_digest(&url, "claude_code", SESSION)
        .unwrap()
        .unwrap();
    assert_eq!(copy.status, "draft");
    assert_eq!(copy.digest["provenance"]["model"], "canned");

    // Only the digest is queued: no transcript events.
    let due = store.outbox_due(10).unwrap();
    assert_eq!(due.len(), 1);
    assert!(due[0].payload["events"].is_null());
    assert!(due[0].payload["digest"]["goal"].is_string());

    let r = deliver_due(&store, &HttpRemote::new(&store)).unwrap();
    assert_eq!(r.sent, 1);
    {
        let seen = seen.lock().unwrap();
        let (path, auth, body) = &seen[0];
        assert_eq!(path, "/v1/sync/drafts");
        assert_eq!(auth, "Bearer pd_AAAAAAAA_secret-device-token-0123456789");
        let body: Value = serde_json::from_str(body).unwrap();
        assert!(body["draft"].is_null(), "the routing flag is not sent");
        assert!(body["outbox_id"].is_string());
        assert!(body["sync_enabled_at"].is_string());
        assert!(body.get("events").is_none());
    }
    let copy = store
        .remote_digest(&url, "claude_code", SESSION)
        .unwrap()
        .unwrap();
    assert_eq!(copy.server_digest_id.as_deref(), Some("srv-1"));

    // The owner edits and approves on the server; the device copy follows.
    let api = Api::resolve(&store, "cli", None).unwrap();
    assert_eq!(api.remote_url(), Some(url.as_str()));
    let pulled = remote::pull_changes(&store, &api, true).unwrap();
    assert_eq!(pulled.applied, 1);
    let copy = store
        .remote_digest(&url, "claude_code", SESSION)
        .unwrap()
        .unwrap();
    assert_eq!(copy.status, "approved");
    assert_eq!(copy.digest["goal"], "Edited on the server.");
    // Throttled: a second ordinary pull within a minute does not call the server.
    let before = seen.lock().unwrap().len();
    remote::pull_changes(&store, &api, false).unwrap();
    assert_eq!(seen.lock().unwrap().len(), before);
}

#[test]
fn commands_without_a_login_say_so() {
    pama_core::secrets::use_mock_store();
    let store = Store::open_in_memory().unwrap();
    let err = Api::resolve(&store, "cli", Some("https://nowhere.example"))
        .err()
        .unwrap();
    assert!(err
        .to_string()
        .contains("pama login --server https://nowhere.example"));
    remote::set_mode(&store, remote::Mode::Remote).unwrap();
    assert!(matches!(
        Api::resolve(&store, "cli", None),
        Err(pama_core::client::ApiError::NotLoggedIn(_))
    ));
}
