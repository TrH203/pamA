//! Capture worker end to end on the device side, with a fake sink in place of the server.

use std::cell::RefCell;
use std::path::PathBuf;

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
    reply: Result<Value, String>,
    retryable: bool,
    bodies: RefCell<Vec<Value>>,
}

impl DigestSink for &FakeSink {
    fn submit(&self, body: &Value) -> Result<Value, SinkError> {
        self.bodies.borrow_mut().push(body.clone());
        match &self.reply {
            Ok(v) => Ok(v.clone()),
            Err(m) if self.retryable => Err(SinkError::Retryable(m.clone())),
            Err(m) => Err(SinkError::Fatal(m.clone())),
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
        reply: Ok(json!({"digest_id": "dg1", "version": 1, "status": "draft"})),
        retryable: false,
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
    assert_eq!(
        store.capture(&id).unwrap().status,
        CaptureStatus::ReadyForReview
    );

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
        reply: Err("connection refused".into()),
        retryable: true,
        bodies: RefCell::new(vec![]),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink: &sink,
    };
    let out = w.run_due().unwrap();
    assert_eq!(out[0].1, CaptureOutcome::Retry("connection refused".into()));
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
        reply: Err("422 invalid".into()),
        retryable: false,
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
}

#[test]
fn projects_not_enabled_are_skipped_and_nothing_is_sent() {
    let (store, rules, id) = setup(false);
    let sink = FakeSink {
        reply: Ok(json!({})),
        retryable: false,
        bodies: RefCell::new(vec![]),
    };
    let w = Worker {
        store: &store,
        rules: &rules,
        sink: &sink,
    };
    assert_eq!(w.run_due().unwrap()[0].1, CaptureOutcome::Skipped);
    assert_eq!(store.capture(&id).unwrap().status, CaptureStatus::Skipped);
    assert!(sink.bodies.borrow().is_empty());
}
