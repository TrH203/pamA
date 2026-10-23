//! Contract test: the Rust `SessionDigest` agrees with contracts/session-digest.schema.json.

use std::fs;
use std::path::PathBuf;

use pama_core::digest::SessionDigest;

fn types_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/types")
}

fn fixtures(prefix: &str) -> Vec<(String, String)> {
    let mut out: Vec<_> = fs::read_dir(types_dir().join("fixtures"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(prefix))
        .map(|p| {
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                fs::read_to_string(&p).unwrap(),
            )
        })
        .collect();
    out.sort();
    assert!(!out.is_empty(), "no fixtures with prefix {prefix}");
    out
}

fn validator() -> jsonschema::Validator {
    let schema: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(types_dir().join("schema/session-digest.schema.json")).unwrap(),
    )
    .unwrap();
    jsonschema::validator_for(&schema).unwrap()
}

#[test]
fn valid_fixtures_round_trip_and_match_schema() {
    let v = validator();
    for (name, raw) in fixtures("digest-valid-") {
        let digest = SessionDigest::from_json(&raw)
            .unwrap_or_else(|e| panic!("{name} should be accepted: {e}"));
        let out = serde_json::to_value(&digest).unwrap();
        assert!(
            v.is_valid(&out),
            "{name}: serialized digest violates the schema"
        );
        let original: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(out, original, "{name}: round trip changed the document");
    }
}

#[test]
fn invalid_fixtures_are_rejected_like_the_schema() {
    let v = validator();
    for (name, raw) in fixtures("digest-invalid-") {
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(
            !v.is_valid(&value),
            "{name}: fixture should violate the schema"
        );
        assert!(
            SessionDigest::from_json(&raw).is_err(),
            "{name}: Rust accepted a document the schema rejects"
        );
    }
}
