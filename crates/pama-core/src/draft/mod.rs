//! On-device digest drafting for the thin client (spec 004, research R3): Layer-1-redacted events
//! → English Session Digest, without a local server. Mirrors the model step of the server's
//! `apps/server/src/pipeline/digest.ts` — same prompt file, transcript budget, output schema and
//! limits — and the shared fixture in `packages/types/fixtures/draft/` keeps both in step.
//! The transcript goes only to the configured model provider, never to the pamA server.

pub mod llm;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::redact::{Counts, RuleSet};

/// Budget for the transcript sent to the model (head + tail, decisions cluster late).
pub const MAX_TRANSCRIPT_CHARS: usize = 48_000;
const HEAD: usize = 12_000;

const PROMPT_FILE: &str = include_str!("../../../../prompts/digest.md");

/// The digest prompt: body and `digest@<version>` from its front matter.
pub struct Prompt {
    pub version: String,
    pub body: String,
}

pub fn prompt() -> Prompt {
    // A Windows checkout may turn the file's line endings into CRLF.
    let text = PROMPT_FILE.replace("\r\n", "\n");
    let rest = text
        .strip_prefix("---\n")
        .expect("prompts/digest.md starts with front matter");
    let (front, body) = rest.split_once("\n---\n").expect("front matter end");
    let version = front
        .lines()
        .find_map(|l| l.strip_prefix("version:"))
        .map(str::trim)
        .expect("prompt version");
    Prompt {
        version: format!("digest@{version}"),
        body: body.trim().to_string(),
    }
}

/// JSON schema of what the model writes (the server's `DraftSchema`).
pub fn output_schema() -> Value {
    let strings = json!({ "type": "array", "items": { "type": "string" } });
    json!({
        "type": "object",
        "properties": {
            "goal": { "type": "string" },
            "decisions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "what": { "type": "string" },
                        "why": { "type": "string" },
                        "alternatives": strings,
                    },
                    "required": ["what", "why"],
                },
            },
            "outcome": { "type": "string" },
            "open_items": strings,
            "modules": strings,
        },
        "required": ["goal", "decisions", "outcome"],
    })
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

fn take(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn take_last(s: &str, n: usize) -> String {
    let skip = chars(s).saturating_sub(n);
    s.chars().skip(skip).collect()
}

/// The transcript text given to the model, from the request body's `events`.
pub fn format_transcript(events: &[Value]) -> String {
    let lines: Vec<String> = events
        .iter()
        .map(|e| {
            let tool = e["tool"].as_str().unwrap_or("?");
            let tag = match e["kind"].as_str().unwrap_or("") {
                "user" => "[user]".to_string(),
                "assistant" => "[assistant]".to_string(),
                "tool_call" => format!("[tool {tool}]"),
                _ => format!("[result {tool}]"),
            };
            format!("{tag} {}", e["text"].as_str().unwrap_or(""))
        })
        .collect();
    let full = lines.join("\n");
    if chars(&full) <= MAX_TRANSCRIPT_CHARS {
        return full;
    }
    format!(
        "{}\n[… middle of the session omitted …]\n{}",
        take(&full, HEAD),
        take_last(&full, MAX_TRANSCRIPT_CHARS - HEAD)
    )
}

/// What the model returns (lenient: missing lists default to empty, like the server's schema).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct DraftReply {
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub decisions: Vec<ReplyDecision>,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub open_items: Vec<String>,
    #[serde(default)]
    pub modules: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReplyDecision {
    #[serde(default)]
    pub what: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub alternatives: Vec<String>,
}

/// `s` cut to `n` characters with a trailing "..." when longer (the server's `cut`).
pub fn cut(s: &str, n: usize) -> String {
    if chars(s) > n {
        format!("{}...", take(s, n - 3))
    } else {
        s.to_string()
    }
}

/// Layer 1 over model output: a model can echo something the transcript rules missed in a
/// different shape, so every string is checked again before it is stored or sent.
struct Masker<'a> {
    rules: &'a RuleSet,
    counts: Counts,
}

impl Masker<'_> {
    fn mask(&mut self, s: &str) -> String {
        let r = self.rules.redact(s, None);
        self.counts.merge(&r.counts);
        r.text
    }
}

fn redactions_json(counts: &[&Value], extra: &Counts) -> Value {
    let mut secret = extra.secret as u64;
    let mut pii = extra.pii as u64;
    let mut by_rule = serde_json::Map::new();
    for c in counts {
        secret += c["secret"].as_u64().unwrap_or(0);
        pii += c["pii"].as_u64().unwrap_or(0);
        for (k, v) in c["by_rule"].as_object().into_iter().flatten() {
            let n = by_rule.get(k).and_then(Value::as_u64).unwrap_or(0) + v.as_u64().unwrap_or(0);
            by_rule.insert(k.clone(), json!(n));
        }
    }
    for (k, v) in &extra.by_rule {
        let n = by_rule.get(k).and_then(Value::as_u64).unwrap_or(0) + u64::from(*v);
        by_rule.insert(k.clone(), json!(n));
    }
    json!({ "secret": secret, "pii": pii, "by_rule": by_rule })
}

/// Build the Session Digest from the request body (as made by `capture::worker::request_body`)
/// and the model's reply. `provenance` is added as given.
pub fn build_digest(
    input: &Value,
    reply: &DraftReply,
    rules: &RuleSet,
    provenance: Value,
) -> Value {
    let mut m = Masker {
        rules,
        counts: Counts::default(),
    };
    let goal = match reply.goal.trim() {
        "" => "Session without a stated goal.".to_string(),
        g => g.to_string(),
    };
    let decisions: Vec<Value> = reply
        .decisions
        .iter()
        .take(30)
        .enumerate()
        .map(|(i, d)| {
            let alternatives: Vec<String> = d
                .alternatives
                .iter()
                .take(10)
                .map(|a| cut(&m.mask(a), 500))
                .collect();
            json!({
                "id": i + 1,
                "what": cut(&m.mask(&d.what), 1000),
                "why": cut(&m.mask(&d.why), 1000),
                "alternatives": alternatives,
            })
        })
        .collect();
    let goal = cut(&m.mask(&goal), 1000);
    let outcome = cut(&m.mask(&reply.outcome), 1000);
    let open_items: Vec<String> = reply
        .open_items
        .iter()
        .take(20)
        .map(|s| cut(&m.mask(s), 500))
        .collect();
    let modules: Vec<String> = reply
        .modules
        .iter()
        .take(30)
        .map(|s| cut(&m.mask(s), 100))
        .collect();

    let bundle_key = input["bundle_key"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| input["git"]["branch"].as_str())
        .unwrap_or("default");
    let mut source = json!({
        "agent": input["agent"],
        "agent_session_id": input["agent_session_id"],
        "project_key": input["project_key"],
        "bundle_key": bundle_key,
        "ended_at": input["ended_at"],
    });
    for k in ["agent_version", "git", "started_at"] {
        if !input[k].is_null() {
            source[k] = input[k].clone();
        }
    }
    let mut digest = json!({
        "schema_version": 1,
        "source": source,
        "goal": goal,
        "decisions": decisions,
        "outcome": outcome,
        "open_items": open_items,
        "modules": modules,
        "redactions": redactions_json(&[&input["redactions"]], &m.counts),
    });
    if !provenance.is_null() {
        digest["provenance"] = provenance;
    }
    digest
}

#[derive(Debug, thiserror::Error)]
pub enum DraftError {
    /// Network, provider down, rate limit, strict offline block: retry later.
    #[error("{0}")]
    Retryable(String),
    /// Misconfiguration or an unusable reply: needs the owner.
    #[error("{0}")]
    Fatal(String),
}

/// Draft a digest for one session: format, call the model, build and validate.
pub fn draft(
    input: &Value,
    model: &dyn llm::DraftModel,
    rules: &RuleSet,
    now: &str,
) -> Result<Value, DraftError> {
    let p = prompt();
    let events = input["events"].as_array().cloned().unwrap_or_default();
    let transcript = format_transcript(&events);
    let user = format!("<transcript>\n{transcript}\n</transcript>");
    let reply = model.complete(&p.body, &user, &output_schema())?;
    let parsed: DraftReply = serde_json::from_value(reply)
        .map_err(|e| DraftError::Fatal(format!("model reply does not match the schema: {e}")))?;
    let digest = build_digest(
        input,
        &parsed,
        rules,
        json!({ "prompt_version": p.version, "model": model.id(), "produced_at": now }),
    );
    crate::digest::SessionDigest::from_json(&digest.to_string())
        .map_err(|e| DraftError::Fatal(format!("drafted digest is invalid: {e}")))?;
    Ok(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> RuleSet {
        RuleSet::load_dir(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../rules"))
            .expect("rules")
    }

    fn fixture() -> Value {
        let raw = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/types/fixtures/draft/basic.json"),
        )
        .expect("fixture");
        serde_json::from_str(&raw).expect("fixture json")
    }

    #[test]
    fn prompt_is_the_shared_file() {
        let p = prompt();
        assert!(p.version.starts_with("digest@"));
        assert!(p.body.starts_with("# pamA digest"));
    }

    #[test]
    fn matches_the_shared_fixture() {
        let f = fixture();
        let events = f["input"]["events"].as_array().unwrap().clone();
        assert_eq!(format_transcript(&events), f["prompt"].as_str().unwrap());
        let reply: DraftReply = serde_json::from_value(f["reply"].clone()).unwrap();
        let got = build_digest(&f["input"], &reply, &rules(), Value::Null);
        assert_eq!(got, f["expected"]);
        crate::digest::SessionDigest::from_json(&got.to_string()).expect("valid digest");
    }

    #[test]
    fn long_transcripts_keep_head_and_tail() {
        let events: Vec<Value> = (0..2_000)
            .map(
                |i| json!({ "kind": "user", "text": format!("message {i:05} {}", "x".repeat(40)) }),
            )
            .collect();
        let t = format_transcript(&events);
        assert!(t.chars().count() <= MAX_TRANSCRIPT_CHARS + 50);
        assert!(t.starts_with("[user] message 00000"));
        assert!(t.contains("[… middle of the session omitted …]"));
        assert!(t.ends_with(&"x".repeat(40)));
        assert!(t.contains("message 01999"));
    }

    #[test]
    fn caps_and_defaults() {
        let reply = DraftReply {
            goal: "  ".into(),
            decisions: (0..40)
                .map(|i| ReplyDecision {
                    what: format!("d{i} {}", "w".repeat(2_000)),
                    why: "because".into(),
                    alternatives: (0..15).map(|j| format!("alt {j}")).collect(),
                })
                .collect(),
            outcome: "ok".into(),
            open_items: (0..25).map(|i| format!("o{i}")).collect(),
            modules: (0..35).map(|i| format!("m{i}")).collect(),
        };
        let input = json!({
            "agent": "codex", "agent_session_id": "s", "project_key": "k",
            "ended_at": "2026-10-25T00:00:00Z", "events": [],
            "redactions": { "secret": 0, "pii": 0 },
        });
        let d = build_digest(&input, &reply, &rules(), Value::Null);
        assert_eq!(d["goal"], "Session without a stated goal.");
        assert_eq!(d["decisions"].as_array().unwrap().len(), 30);
        assert_eq!(
            d["decisions"][0]["what"].as_str().unwrap().chars().count(),
            1000
        );
        assert!(d["decisions"][0]["what"].as_str().unwrap().ends_with("..."));
        assert_eq!(
            d["decisions"][0]["alternatives"].as_array().unwrap().len(),
            10
        );
        assert_eq!(d["open_items"].as_array().unwrap().len(), 20);
        assert_eq!(d["modules"].as_array().unwrap().len(), 30);
        assert_eq!(d["source"]["bundle_key"], "default");
    }

    #[test]
    fn secrets_echoed_by_the_model_never_survive() {
        let reply = DraftReply {
            goal: "Rotate AKIAZ7Q4PL2XWN3VB5KD".into(),
            decisions: vec![ReplyDecision {
                what: "Use password=hunter2-Very-Secret-99 for the db".into(),
                why: "postgres://admin:s3cr3tPassw0rd@db.internal:5432/app".into(),
                alternatives: vec!["ghp_R8x2Kq9LmZt4Vb7Np1Wc5Hs3Jd6Fg0YuQeAi".into()],
            }],
            outcome: "Mail lan.tran@acme-corp.vn".into(),
            ..Default::default()
        };
        let input = json!({
            "agent": "claude_code", "agent_session_id": "s", "project_key": "k",
            "ended_at": "2026-10-25T00:00:00Z", "events": [],
            "redactions": { "secret": 1, "pii": 0, "by_rule": { "x": 1 } },
        });
        let d = build_digest(&input, &reply, &rules(), Value::Null);
        let text = d.to_string();
        for leaked in [
            "AKIAZ7Q4PL2XWN3VB5KD",
            "s3cr3tPassw0rd",
            "ghp_R8x2Kq9LmZt4Vb7Np1Wc5Hs3Jd6Fg0YuQeAi",
            "lan.tran@acme-corp.vn",
        ] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
        assert!(d["redactions"]["secret"].as_u64().unwrap() > 1);
    }

    struct Canned(Value);
    impl llm::DraftModel for Canned {
        fn id(&self) -> String {
            "canned".into()
        }
        fn complete(&self, system: &str, user: &str, _: &Value) -> Result<Value, DraftError> {
            assert!(system.starts_with("# pamA digest"));
            assert!(user.starts_with("<transcript>\n"));
            Ok(self.0.clone())
        }
    }

    #[test]
    fn drafts_end_to_end_with_provenance() {
        let f = fixture();
        let d = draft(
            &f["input"],
            &Canned(f["reply"].clone()),
            &rules(),
            "2026-10-25T10:00:00Z",
        )
        .expect("draft");
        assert_eq!(d["provenance"]["model"], "canned");
        assert_eq!(d["provenance"]["prompt_version"], prompt().version);
        let mut without = d.clone();
        without.as_object_mut().unwrap().remove("provenance");
        assert_eq!(without, f["expected"]);
    }

    #[test]
    fn unusable_replies_are_fatal() {
        let f = fixture();
        let err = draft(&f["input"], &Canned(json!("not an object")), &rules(), "t").unwrap_err();
        assert!(matches!(err, DraftError::Fatal(_)));
    }
}
