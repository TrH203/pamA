//! Layer 1 over normalized events: structural rules drop secret files and env dumps, regex rules
//! redact the rest, and counts are reported by type (US1 acceptance 2).

use std::path::PathBuf;

use pama_core::redact::RuleSet;
use pama_core::session::{claude, codex, redact_session};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn rules() -> RuleSet {
    RuleSet::load_dir(&root().join("../../rules")).unwrap()
}

fn text(s: &pama_core::session::NormalizedSession) -> String {
    s.events
        .iter()
        .flat_map(|e| {
            [
                Some(e.text.as_str()),
                e.command.as_deref(),
                e.path.as_deref(),
            ]
        })
        .flatten()
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn claude_session_has_no_secrets_left() {
    let mut s = claude::parse(&root().join(
        "tests/fixtures/claude/2.1/-Users-dev-work-shop/7c1e2f30-0000-4a1b-9c2d-3e4f5a6b7c8d.jsonl",
    ))
    .unwrap();
    let counts = redact_session(&rules(), &mut s);
    let all = text(&s);
    for secret in [
        "AKIAZ7Q4PL2XWN3VB5KD",
        "S3cretPw0rd",
        "ctk_9f8e7d6c5b4a3210",
        "9f8e7d6c5b4a32100123abcd",
        "lan.tran@acme-corp.vn",
    ] {
        assert!(!all.contains(secret), "{secret} survived:\n{all}");
    }
    assert!(all.contains("[DROPPED:dotenv-file-read]"), "{all}");
    assert!(all.contains("[DROPPED:env-dump]"), "{all}");
    assert!(all.contains("[PII:email]"));
    assert_eq!(counts.by_rule.get("dotenv-file-read"), Some(&1));
    assert_eq!(counts.by_rule.get("env-dump"), Some(&1));
    assert!(counts.secret >= 2);
    assert_eq!(counts.pii, 1);
    // Non-secret content survives.
    assert!(all.contains("refunds will NOT include the shipping fee"));
}

#[test]
fn codex_cat_of_env_file_is_dropped() {
    let mut s = codex::parse(
        &root().join(
            "tests/fixtures/codex/0.80/rollout-2026-10-21T10-00-00-0199aa11-2222-7333-8444-555566667777.jsonl",
        ),
    )
    .unwrap();
    let counts = redact_session(&rules(), &mut s);
    let all = text(&s);
    assert!(!all.contains("hunter2"), "{all}");
    assert!(all.contains("[DROPPED:cat-secret-file]"));
    assert_eq!(counts.by_rule.get("cat-secret-file"), Some(&1));
}
