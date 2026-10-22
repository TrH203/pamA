//! Strict offline mode on the device (FR-027): undeclared hosts are blocked before any request is
//! made and show up in the network log with allowed = false; declared hosts and loopback pass.

use pama_core::net::{GuardedClient, NetError, Policy};
use pama_core::store::{OutboxKind, Store};
use pama_core::sync::{deliver_due, HttpRemote};
use serde_json::json;

fn strict(hosts: &[&str]) -> Policy {
    Policy {
        strict: true,
        declared_hosts: hosts.iter().map(|h| h.to_string()).collect(),
    }
}

#[test]
fn undeclared_hosts_are_blocked_and_logged() {
    let store = Store::open_in_memory().unwrap();
    let c = GuardedClient::new(strict(&["pama.acme.vn"]), &store, "desktop");
    assert!(matches!(
        c.check("https://api.anthropic.com/v1/messages", "llm"),
        Err(NetError::Blocked(_))
    ));
    assert!(c
        .check("https://pama.acme.vn/v1/sync/digests", "sync.digest")
        .is_ok());
    assert!(c.check("http://127.0.0.1:7465/v1/health", "health").is_ok());
    let log = store.network_log(10).unwrap();
    let blocked: Vec<_> = log
        .iter()
        .filter(|e| !e.allowed)
        .map(|e| e.host.as_str())
        .collect();
    assert_eq!(blocked, vec!["api.anthropic.com"]);
    assert_eq!(log.len(), 3);
}

#[test]
fn sync_to_an_undeclared_server_never_leaves_the_machine() {
    let store = Store::open_in_memory().unwrap();
    store.set_setting("strict_offline", "true").unwrap();
    store.set_setting("declared_hosts", "localhost").unwrap();
    store
        .outbox_push(
            OutboxKind::DigestUpsert,
            "https://pama.example.net",
            &json!({ "digest": {} }),
        )
        .unwrap();
    let remote = HttpRemote::new(&store);
    let r = deliver_due(&store, &remote).unwrap();
    assert_eq!(r.sent, 0);
    assert_eq!(
        r.retrying, 1,
        "kept for later: the owner may declare the host"
    );
    let log = store.network_log(10).unwrap();
    assert_eq!(log[0].host, "pama.example.net");
    assert!(!log[0].allowed);
}
