//! Device outbox (FR-026): pending digests are delivered exactly once across offline periods,
//! with backoff; rejected deliveries go dead immediately; repeated failures go dead after the
//! retry limit.

use std::cell::RefCell;
use std::collections::HashMap;

use pama_core::store::{OutboxKind, Store, MAX_RETRIES};
use pama_core::sync::{deliver_due, DeliverError, Remote};
use serde_json::{json, Value};

#[derive(Default)]
struct FakeRemote {
    /// Fail with Retryable this many more times (simulated offline period).
    offline_for: RefCell<u32>,
    reject: bool,
    received: RefCell<Vec<(String, Value)>>,
    by_id: RefCell<HashMap<String, usize>>,
}

impl Remote for FakeRemote {
    fn deliver(&self, target: &str, _kind: OutboxKind, body: &Value) -> Result<(), DeliverError> {
        if *self.offline_for.borrow() > 0 {
            *self.offline_for.borrow_mut() -= 1;
            return Err(DeliverError::Retryable("connection refused".into()));
        }
        if self.reject {
            return Err(DeliverError::Rejected("409 sync_disabled".into()));
        }
        let id = body["outbox_id"].as_str().unwrap().to_string();
        *self.by_id.borrow_mut().entry(id).or_default() += 1;
        self.received
            .borrow_mut()
            .push((target.to_string(), body.clone()));
        Ok(())
    }
}

fn store_with(n: usize) -> Store {
    let s = Store::open_in_memory().unwrap();
    for i in 0..n {
        s.outbox_push(
            OutboxKind::DigestUpsert,
            "https://pama.acme.vn",
            &json!({ "digest": { "n": i } }),
        )
        .unwrap();
    }
    s
}

#[test]
fn delivers_each_item_exactly_once_across_an_offline_period() {
    let s = store_with(3);
    let remote = FakeRemote {
        offline_for: RefCell::new(2),
        ..Default::default()
    };
    let r1 = deliver_due(&s, &remote).unwrap();
    assert_eq!(
        r1.sent, 1,
        "first attempt: 2 fail offline, the third goes through"
    );
    assert_eq!(r1.retrying, 2);
    // Still offline-backoff: nothing due yet.
    assert_eq!(deliver_due(&s, &remote).unwrap().sent, 0);
    s.outbox_retry_now().unwrap();
    let r2 = deliver_due(&s, &remote).unwrap();
    assert_eq!(r2.sent, 2);
    s.outbox_retry_now().unwrap();
    assert_eq!(deliver_due(&s, &remote).unwrap().sent, 0, "nothing left");
    let by_id = remote.by_id.borrow();
    assert_eq!(by_id.len(), 3);
    assert!(
        by_id.values().all(|n| *n == 1),
        "each outbox id delivered once"
    );
    // The body carries the idempotency key and the payload.
    let (target, body) = &remote.received.borrow()[0];
    assert_eq!(target, "https://pama.acme.vn");
    assert!(body["digest"]["n"].is_number());
}

#[test]
fn rejected_items_go_dead_immediately() {
    let s = store_with(1);
    let remote = FakeRemote {
        reject: true,
        ..Default::default()
    };
    let r = deliver_due(&s, &remote).unwrap();
    assert_eq!(r.dead, 1);
    s.outbox_retry_now().unwrap();
    assert_eq!(deliver_due(&s, &remote).unwrap(), Default::default());
}

#[test]
fn items_go_dead_after_the_retry_limit() {
    let s = store_with(1);
    let remote = FakeRemote {
        offline_for: RefCell::new(1_000),
        ..Default::default()
    };
    for _ in 0..=MAX_RETRIES {
        s.outbox_retry_now().unwrap();
        deliver_due(&s, &remote).unwrap();
    }
    s.outbox_retry_now().unwrap();
    assert!(
        s.outbox_due(10).unwrap().is_empty(),
        "dead items are not retried"
    );
    assert_eq!(s.outbox_counts().unwrap().dead, 1);
}
