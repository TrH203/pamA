//! Capture worker end to end on the device side, with a fake sink in place of the server.

use std::cell::RefCell;
use std::path::PathBuf;

use pama_core::capture::errors::{CodedError, ErrorCode};
use pama_core::capture::worker::{CaptureOutcome, DigestSink, SinkError, Worker};
use pama_core::capture::{enable_project, KEY_CAPTURE_ALL};
use pama_core::redact::RuleSet;
use pama_core::store::{Agent, CaptureStatus, NewCapture, Store};
use serde_json::{json, Value};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn claude_fixture() -> String {
    root()
        .join("tests/fixtures/claude/2.1/-Users-dev-work-shop/7c1e2f30-0000-4a1b-9c2d-3e4f5a6b7c8d.jsonl")
        .to_string_lossy()
        .into_owned()
}

struct FakeSink {
    reply: Result<Value, (ErrorCode, String)>,
    bodies: RefCell<Vec<Value>>,
}

impl DigestSink for &FakeSink {
    fn submit(&self, body: &Value) -> Result<Value, SinkError> {
        self.bodies.borrow_mut().push(body.clone());
        match &self.reply {
            Ok(v) => Ok(v.clone()),
            Err((code, m)) => Err(SinkError::new(*code, m.clone())),
        }
    }
}

fn setup(all: bool) -> (Store, RuleSet, String) {
    let store = Store::open_in_memory().unwrap();
    if all {
        store.set_setting(KEY_CAPTURE_ALL, "true").unwrap();
    }
    let rules = RuleSet::load_dir(&root().join("../../rules")).unwrap();
    let id = store
        .enqueue_capture(
            &NewCapture {
                agent: Agent::ClaudeCode,
                agent_session_id: "7c1e2f30-0000-4a1b-9c2d-3e4f5a6b7c8d".into(),
                transcript_path: claude_fixture(),
                cwd: Some("/Users/dev/work/shop".into()),
                reason: Some("prompt_input_exit".into()),
            },
            0,
        )
        .unwrap();
    (store, rules, id)
}

#[test]
fn submits_redacted_events_and_marks_ready_for_review() {
    let (store, rules, id) = setup(false);
    enable_project(&store, "/Users/dev/work/shop").unwrap();
    let sink = FakeSink {
        reply: Ok(json!({"digest_id": "dg1", "version": 1, "status": "draft", "run_id": "run1"})),
        bodies: RefCell::new(vec![]),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink: &sink,
    };
    let out = w.run_due().unwrap();
    assert_eq!(
        out,
        vec![(
            id.clone(),
            CaptureOutcome::Submitted {
                digest_id: "dg1".into(),
                status: "draft".into()
            }
        )]
    );
    let c = store.capture(&id).unwrap();
    assert_eq!(c.status, CaptureStatus::Submitted);
    assert_eq!(c.digest_id.as_deref(), Some("dg1"));
    let attempts = store.attempts(&id).unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].stage, "submitted");
    assert_eq!(attempts[0].outcome.as_deref(), Some("succeeded"));
    assert_eq!(attempts[0].digest_id.as_deref(), Some("dg1"));
    assert_eq!(attempts[0].run_id.as_deref(), Some("run1"));

    let body = &sink.bodies.borrow()[0];
    let raw = body.to_string();
    for secret in [
        "AKIAZ7Q4PL2XWN3VB5KD",
        "S3cretPw0rd",
        "lan.tran@acme-corp.vn",
        "/Users/dev/work/shop\"",
    ] {
        assert!(!raw.contains(secret), "{secret} leaked into the request");
    }
    assert_eq!(body["agent"], "claude_code");
    assert_eq!(body["bundle_key"], "feat/refund-shipping");
    assert!(
        body["project_key"].as_str().unwrap().starts_with("p:"),
        "no remote → path hash"
    );
    assert_eq!(body["project_name"], "shop");
    assert!(body["redactions"]["secret"].as_u64().unwrap() >= 2);
    assert!(body["ended_at"]
        .as_str()
        .unwrap()
        .starts_with("2026-10-20T"));
}

#[test]
fn retries_when_the_server_is_unavailable() {
    let (store, rules, id) = setup(true);
    let sink = FakeSink {
        reply: Err((ErrorCode::ServerDown, "connection refused".into())),
        bodies: RefCell::new(vec![]),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink: &sink,
    };
    let out = w.run_due().unwrap();
    assert_eq!(
        out[0].1,
        CaptureOutcome::Retry(CodedError::new(ErrorCode::ServerDown, "connection refused"))
    );
    let c = store.capture(&id).unwrap();
    assert_eq!(c.status, CaptureStatus::Detected);
    assert_eq!(c.attempts, 1);
    assert!(
        store.due_captures(10).unwrap().is_empty(),
        "backoff before the next attempt"
    );
}

#[test]
fn rejected_input_fails_without_retry() {
    let (store, rules, id) = setup(true);
    let sink = FakeSink {
        reply: Err((ErrorCode::SyncRejected, "422 invalid".into())),
        bodies: RefCell::new(vec![]),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink: &sink,
    };
    w.run_due().unwrap();
    let c = store.capture(&id).unwrap();
    assert_eq!(c.status, CaptureStatus::Failed);
    assert_eq!(c.error.as_deref(), Some("422 invalid"));
    assert_eq!(c.error_code.as_deref(), Some("sync_rejected"));
    let a = &store.attempts(&id).unwrap()[0];
    assert_eq!(a.outcome.as_deref(), Some("failed"));
    assert_eq!(a.error_code.as_deref(), Some("sync_rejected"));
}

#[test]
fn projects_not_enabled_are_skipped_and_nothing_is_sent() {
    let (store, rules, id) = setup(false);
    let sink = FakeSink {
        reply: Ok(json!({})),
        bodies: RefCell::new(vec![]),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink: &sink,
    };
    assert_eq!(
        w.run_due().unwrap()[0].1,
        CaptureOutcome::Skipped(ErrorCode::ProjectNotEnabled)
    );
    let c = store.capture(&id).unwrap();
    assert_eq!(c.status, CaptureStatus::Skipped);
    assert_eq!(c.error_code.as_deref(), Some("project_not_enabled"));
    assert!(sink.bodies.borrow().is_empty());
}

#[test]
fn config_errors_stop_and_wait_for_the_user() {
    let (store, rules, id) = setup(true);
    let sink = FakeSink {
        reply: Err((
            ErrorCode::ProviderAuth,
            "Small model (openrouter x) rejected the API key".into(),
        )),
        bodies: RefCell::new(vec![]),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink: &sink,
    };
    assert!(matches!(
        w.run_due().unwrap()[0].1,
        CaptureOutcome::Failed(_)
    ));
    assert_eq!(store.capture(&id).unwrap().status, CaptureStatus::Failed);
    assert!(store.due_captures(10).unwrap().is_empty());
    // The user fixed the key and retries: a second attempt, the first one kept.
    assert!(store.retry_capture(&id).unwrap());
    let ok = FakeSink {
        reply: Ok(json!({"digest_id": "dg2", "status": "draft"})),
        bodies: RefCell::new(vec![]),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink: &ok,
    };
    w.run_due().unwrap();
    let h = store.attempts(&id).unwrap();
    assert_eq!(h.len(), 2);
    assert_eq!(h[0].error_code.as_deref(), Some("provider_auth"));
    assert_eq!(h[1].outcome.as_deref(), Some("succeeded"));
}

#[test]
fn empty_sessions_are_skipped_before_any_model_call() {
    let store = Store::open_in_memory().unwrap();
    store.set_setting(KEY_CAPTURE_ALL, "true").unwrap();
    let dir = std::env::temp_dir().join(format!("pama-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("empty.jsonl");
    std::fs::write(
        &path,
        r#"{"type":"user","sessionId":"empty-1","cwd":"/w","message":{"role":"user","content":"hi"}}
"#,
    )
    .unwrap();
    let id = store
        .enqueue_capture(
            &NewCapture {
                agent: Agent::ClaudeCode,
                agent_session_id: "empty-1".into(),
                transcript_path: path.to_string_lossy().into_owned(),
                cwd: Some("/w".into()),
                reason: None,
            },
            0,
        )
        .unwrap();
    let rules = RuleSet::load_dir(&root().join("../../rules")).unwrap();
    let sink = FakeSink {
        reply: Ok(json!({})),
        bodies: RefCell::new(vec![]),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink: &sink,
    };
    assert_eq!(
        w.run_due().unwrap()[0].1,
        CaptureOutcome::Skipped(ErrorCode::EmptySession)
    );
    assert!(sink.bodies.borrow().is_empty());
    assert_eq!(
        store.capture(&id).unwrap().error_code.as_deref(),
        Some("empty_session")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

fn body_for(name: &str) -> Value {
    use pama_core::redact::Counts;
    use pama_core::session::claude;
    let s = claude::parse(&root().join(format!("tests/fixtures/claude-branches/{name}.jsonl")))
        .unwrap();
    pama_core::capture::worker::request_body(&s, &Counts::default(), "fallback")
}

#[test]
fn multi_branch_session_is_filed_under_the_filing_branch_with_the_full_list() {
    let body = body_for("multi-branch");
    assert_eq!(body["bundle_key"], "feat/login");
    assert_eq!(body["git"]["branch"], "feat/login");
    let names: Vec<_> = body["git"]["branches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["main", "feat/login", "fix/typo"]);
    assert_eq!(body["git"]["branches"][1]["events"], 30);
}

#[test]
fn single_branch_session_keeps_the_legacy_fields_and_adds_a_one_entry_list() {
    let body = body_for("main-only");
    assert_eq!(body["bundle_key"], "main");
    assert_eq!(body["git"]["branch"], "main");
    assert_eq!(body["git"]["branches"].as_array().unwrap().len(), 1);
}

#[test]
fn session_without_branch_info_sends_no_branch_list() {
    let body = body_for("no-branch");
    assert!(body["git"].get("branches").is_none());
}
