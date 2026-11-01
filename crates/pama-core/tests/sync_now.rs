//! Sync controls (spec 007): `sync now` delivers everything waiting regardless of backoff and
//! pulls review decisions back; failed items can be listed, retried and dropped; task changes go
//! to `/v1/sync/bundles` only on servers that accept them; the affected-links check asks the
//! target. A tiny HTTP server stands in for the pamA server.

use std::cell::RefCell;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use pama_core::client::Api;
use pama_core::remote;
use pama_core::store::{OutboxKind, OutboxMatch, Store};
use pama_core::sync::{
    deliver_due, describe_item, sync_now, token_key, DeliverError, HttpRemote, Remote,
};
use serde_json::{json, Value};

type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// Answers by path prefix; records (path with query, body) of each request.
fn mock_server(capabilities: &'static [&'static str]) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                reader.read_line(&mut h).unwrap();
                if h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; len];
            reader.read_exact(&mut body).unwrap();
            log.lock()
                .unwrap()
                .push((path.clone(), String::from_utf8_lossy(&body).into()));
            let reply = if path.starts_with("/v1/health") {
                json!({ "status": "ok", "capabilities": capabilities })
            } else if path.starts_with("/v1/sync/bundles") {
                json!({ "bundle_id": "b1", "moved": 1 })
            } else if path.starts_with("/v1/sync/affected-links") {
                json!({ "links": [{ "slug": "abcdefgh", "title": "Refund FAQ", "empty": true, "lost": [] }] })
            } else if path.starts_with("/v1/sync/changes") {
                json!({ "changes": [], "cursor": "0" })
            } else {
                json!({ "digest_id": "d1", "version": 1 })
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

fn logged_in(store: &Store, url: &str) {
    pama_core::secrets::use_mock_store();
    pama_core::secrets::set(
        &token_key(url),
        "pd_AAAAAAAA_secret-device-token-0123456789",
    )
    .unwrap();
    let _ = store;
}

/// Offline for the first `offline` calls, then accepts.
#[derive(Default)]
struct Flaky {
    offline: RefCell<u32>,
    reject: bool,
    got: RefCell<usize>,
}

impl Remote for Flaky {
    fn deliver(&self, _: &str, _: OutboxKind, _: &Value) -> Result<(), DeliverError> {
        if self.reject {
            return Err(DeliverError::Rejected(
                "server returned 422: invalid".into(),
            ));
        }
        if *self.offline.borrow() > 0 {
            *self.offline.borrow_mut() -= 1;
            return Err(DeliverError::Retryable("connection refused".into()));
        }
        *self.got.borrow_mut() += 1;
        Ok(())
    }
}

#[test]
fn sync_now_ignores_backoff_and_reports() {
    let s = Store::open_in_memory().unwrap();
    for i in 0..2 {
        s.outbox_push(OutboxKind::DigestUpsert, "https://t", &json!({ "n": i }))
            .unwrap();
    }
    let offline = Flaky {
        offline: RefCell::new(2),
        ..Default::default()
    };
    let r = sync_now(&s, None, &offline, None).unwrap();
    assert_eq!(r.delivery.retrying, 2);
    assert_eq!(r.pending, 2);
    // Back online: a normal delivery would wait for the backoff, `sync now` does not.
    assert_eq!(deliver_due(&s, &offline).unwrap().sent, 0, "backoff");
    let r = sync_now(&s, None, &offline, None).unwrap();
    assert_eq!(r.delivery.sent, 2);
    assert_eq!((r.pending, r.dead), (0, 0));
    assert!(r.pulled.is_none());
}

#[test]
fn failed_items_are_listed_retried_and_dropped() {
    let s = Store::open_in_memory().unwrap();
    s.outbox_push(
        OutboxKind::DigestUpsert,
        "https://t",
        &json!({ "digest": { "goal": "Refunds", "source": { "project_key": "k", "bundle_key": "feat/a" } } }),
    )
    .unwrap();
    s.outbox_push(
        OutboxKind::SourceTombstone,
        "https://t",
        &json!({ "source_type": "bundle", "source_key": "k#feat/a" }),
    )
    .unwrap();
    let rejecting = Flaky {
        reject: true,
        ..Default::default()
    };
    assert_eq!(deliver_due(&s, &rejecting).unwrap().dead, 2);
    let dead = s.outbox_dead_items(10).unwrap();
    assert_eq!(dead.len(), 2);
    let what: Vec<String> = dead
        .iter()
        .map(|d| describe_item(d.kind, &d.payload))
        .collect();
    assert!(what.contains(&"digest k / feat/a: Refunds".to_string()));
    assert!(what.contains(&"delete task k#feat/a".to_string()));
    assert_eq!(
        dead[0].last_error.as_deref(),
        Some("server returned 422: invalid")
    );

    // Fixed on the server: retry one by id prefix, drop the other.
    let tomb = dead
        .iter()
        .find(|d| d.kind == OutboxKind::SourceTombstone)
        .unwrap();
    let digest = dead
        .iter()
        .find(|d| d.kind == OutboxKind::DigestUpsert)
        .unwrap();
    let OutboxMatch::One(full) = s.outbox_match_dead(&digest.id).unwrap() else {
        panic!("one match");
    };
    assert!(s.outbox_revive(&full).unwrap());
    let ok = Flaky::default();
    assert_eq!(deliver_due(&s, &ok).unwrap().sent, 1);
    assert!(s.outbox_drop(&tomb.id).unwrap());
    assert!(s.outbox_dead_items(10).unwrap().is_empty());
    assert_eq!(s.outbox_counts().unwrap().dead, 0);
}

#[test]
fn the_owners_task_key_goes_only_to_servers_that_read_it() {
    let store = Store::open_in_memory().unwrap();
    let digest = json!({
        "digest": { "source": { "agent": "claude_code", "agent_session_id": "s2",
                                "project_key": "github.com/acme/shop", "bundle_key": "feat/a" } },
        "approved_at": "2026-10-20T10:00:00Z", "sync_enabled_at": "2026-10-20T09:00:00Z",
        "bundle_name": "Refund worker", "bundle_name_source": "owner", "bundle_ref": "id:01X",
    });
    let body_sent = |caps: &'static [&'static str]| {
        let (url, seen) = mock_server(caps);
        logged_in(&store, &url);
        store
            .outbox_push(OutboxKind::DigestUpsert, &url, &digest)
            .unwrap();
        assert_eq!(
            deliver_due(&store, &HttpRemote::new(&store)).unwrap().sent,
            1
        );
        let seen = seen.lock().unwrap();
        let (_, body) = seen.iter().find(|(p, _)| p == "/v1/sync/digests").unwrap();
        serde_json::from_str::<Value>(body).unwrap()
    };
    assert_eq!(
        body_sent(&["branch_lists", "bundle_refs"])["bundle_ref"],
        "id:01X"
    );
    assert!(body_sent(&["branch_lists"]).get("bundle_ref").is_none());
}

#[test]
fn task_changes_go_only_to_servers_that_accept_them() {
    let store = Store::open_in_memory().unwrap();
    let change = json!({
        "project_key": "github.com/acme/shop", "bundle_ref": "id:01X", "name": "Refund worker",
        "name_source": "owner", "sessions": [{ "agent": "claude_code", "agent_session_id": "s2" }],
    });

    let (new_url, new_seen) = mock_server(&["branch_lists", "bundle_changes"]);
    logged_in(&store, &new_url);
    store
        .outbox_push(OutboxKind::BundleChange, &new_url, &change)
        .unwrap();
    let r = deliver_due(&store, &HttpRemote::new(&store)).unwrap();
    assert_eq!(r.sent, 1);
    {
        let seen = new_seen.lock().unwrap();
        let (path, body) = seen.iter().find(|(p, _)| p == "/v1/sync/bundles").unwrap();
        assert_eq!(path, "/v1/sync/bundles");
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["bundle_ref"], "id:01X");
        assert!(body["outbox_id"].is_string());
    }

    let (old_url, old_seen) = mock_server(&["branch_lists"]);
    logged_in(&store, &old_url);
    store
        .outbox_push(OutboxKind::BundleChange, &old_url, &change)
        .unwrap();
    let r = deliver_due(&store, &HttpRemote::new(&store)).unwrap();
    assert_eq!(r.dead, 1);
    assert!(old_seen
        .lock()
        .unwrap()
        .iter()
        .all(|(p, _)| p != "/v1/sync/bundles"));
    let dead = store.outbox_dead_items(10).unwrap();
    assert!(dead[0]
        .last_error
        .as_deref()
        .unwrap()
        .contains("too old to receive task renames"));
}

#[test]
fn affected_links_are_asked_from_the_target() {
    let store = Store::open_in_memory().unwrap();
    let (url, seen) = mock_server(&["affected_links"]);
    logged_in(&store, &url);
    let links = HttpRemote::new(&store)
        .affected_links(&url, "bundle", "github.com/acme/shop#feat/a")
        .unwrap()
        .unwrap();
    assert_eq!(links[0]["slug"], "abcdefgh");
    let path = seen.lock().unwrap().last().unwrap().0.clone();
    assert_eq!(
        path,
        "/v1/sync/affected-links?source_type=bundle&source_key=github.com%2Facme%2Fshop%23feat%2Fa"
    );

    let (old, _) = mock_server(&[]);
    logged_in(&store, &old);
    assert!(HttpRemote::new(&store)
        .affected_links(&old, "project", "k")
        .unwrap()
        .is_none());
}

#[test]
fn sync_now_in_remote_mode_pulls_review_decisions() {
    let store = Store::open_in_memory().unwrap();
    let (url, seen) = mock_server(&["drafts", "changes"]);
    logged_in(&store, &url);
    remote::add_server(
        &store,
        remote::ServerEntry {
            url: url.clone(),
            workspace_id: None,
            device_id: None,
        },
    )
    .unwrap();
    remote::set_mode(&store, remote::Mode::Remote).unwrap();
    let api = Api::resolve(&store, "cli", None).unwrap();
    let r = sync_now(&store, None, &HttpRemote::new(&store), Some(&api)).unwrap();
    assert_eq!(r.pulled.unwrap().applied, 0);
    assert!(seen
        .lock()
        .unwrap()
        .iter()
        .any(|(p, _)| p.starts_with("/v1/sync/changes")));
}
