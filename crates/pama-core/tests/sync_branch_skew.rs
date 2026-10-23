//! Version skew (spec 002 research R3): an older strict server rejects `source.git.branches`, so the
//! sync client only sends it to servers that advertise `branch_lists`.

use pama_core::sync::{prepare_digest_body, supports_branch_lists};
use serde_json::{json, Value};

fn body() -> Value {
    json!({
        "outbox_id": "ob1",
        "bundle_name": "Refunds",
        "digest": { "source": {
            "agent": "codex", "bundle_key": "feat/a",
            "git": { "branch": "feat/a", "branches": [{"name": "feat/a"}, {"name": "fix/b"}] }
        }}
    })
}

#[test]
fn health_without_capabilities_means_no_branch_lists() {
    assert!(!supports_branch_lists(
        &json!({"status": "ok", "version": "0.1.0"})
    ));
    assert!(!supports_branch_lists(
        &json!({"capabilities": ["something_else"]})
    ));
    assert!(!supports_branch_lists(
        &json!({"capabilities": "branch_lists"})
    ));
    assert!(supports_branch_lists(
        &json!({"capabilities": ["branch_lists"]})
    ));
}

#[test]
fn strips_the_list_for_older_servers_and_keeps_the_legacy_fields() {
    let mut b = body();
    prepare_digest_body(&mut b, false);
    let git = &b["digest"]["source"]["git"];
    assert!(git.get("branches").is_none());
    assert_eq!(git["branch"], "feat/a");
    assert_eq!(b["digest"]["source"]["bundle_key"], "feat/a");
    assert_eq!(b["bundle_name"], "Refunds");
}

#[test]
fn sends_the_list_to_servers_that_support_it() {
    let mut b = body();
    prepare_digest_body(&mut b, true);
    assert_eq!(b, body());
}

#[test]
fn tolerates_bodies_without_git() {
    let mut b = json!({"digest": {"source": {"agent": "codex"}}});
    prepare_digest_body(&mut b, false);
    assert_eq!(b, json!({"digest": {"source": {"agent": "codex"}}}));
    let mut c = json!({"outbox_id": "x"});
    prepare_digest_body(&mut c, false);
    assert_eq!(c, json!({"outbox_id": "x"}));
}
