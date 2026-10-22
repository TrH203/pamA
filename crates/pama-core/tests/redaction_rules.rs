//! Layer-1 rule tests over the shared corpus in rules/tests (Constitution V: written first).
//!
//! Corpus format: `# secret: <value>` header lines list values that must disappear; the rest is
//! the text. `{{}}` is removed before scanning so token-shaped fixtures are not contiguous in the
//! repository. Golden outputs in rules/tests/expected are shared with the TypeScript test;
//! regenerate them with `PAMA_BLESS=1 cargo test -p pama-core --test redaction_rules`.

use std::fs;
use std::path::{Path, PathBuf};

use pama_core::redact::{Category, RuleSet};

fn rules_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../rules")
}

struct Case {
    name: String,
    secrets: Vec<String>,
    text: String,
}

fn load_cases(kind: &str) -> Vec<Case> {
    let dir = rules_dir().join("tests").join(kind);
    let mut cases: Vec<Case> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "txt"))
        .map(|p| parse_case(&p))
        .collect();
    cases.sort_by(|a, b| a.name.cmp(&b.name));
    assert!(!cases.is_empty(), "no {kind} cases");
    cases
}

fn parse_case(path: &Path) -> Case {
    let raw = fs::read_to_string(path).unwrap().replace("{{}}", "");
    let mut secrets = Vec::new();
    let mut body = Vec::new();
    for line in raw.lines() {
        match line.strip_prefix("# secret: ") {
            Some(s) => secrets.push(s.to_string()),
            None => body.push(line),
        }
    }
    Case {
        name: path.file_name().unwrap().to_string_lossy().into_owned(),
        secrets,
        text: body.join("\n"),
    }
}

fn ruleset() -> RuleSet {
    RuleSet::load_dir(&rules_dir()).expect("rules load")
}

#[test]
fn all_rules_compile_with_ascii_semantics() {
    let rs = ruleset();
    let gitleaks = fs::read_to_string(rules_dir().join("gitleaks.toml")).unwrap();
    let vendored = gitleaks.matches("[[rules]]").count();
    // Path-only rules (no regex) do not apply to transcript text.
    assert!(
        rs.regex_rule_count() >= vendored - 1,
        "some gitleaks rules failed to load"
    );
    assert!(rs.rule_ids().any(|id| id == "dotenv-file-read") || rs.structural_count() > 0);
}

#[test]
fn positives_are_redacted_with_typed_placeholders() {
    let rs = ruleset();
    let bless = std::env::var_os("PAMA_BLESS").is_some();
    for case in load_cases("positives") {
        assert!(
            !case.secrets.is_empty(),
            "{}: no `# secret:` header",
            case.name
        );
        let out = rs.redact(&case.text, None);
        for s in &case.secrets {
            assert!(
                !out.text.contains(s.as_str()),
                "{}: secret {s:?} survived:\n{}",
                case.name,
                out.text
            );
        }
        assert!(
            out.text.contains("[SECRET:") || out.text.contains("[PII:"),
            "{}: no typed placeholder",
            case.name
        );
        let total: u32 = out.counts.by_rule.values().sum();
        assert_eq!(
            total,
            out.counts.secret + out.counts.pii,
            "{}: counts disagree",
            case.name
        );
        assert!(
            total as usize >= case.secrets.len(),
            "{}: fewer redactions than secrets",
            case.name
        );

        let golden = rules_dir().join("tests/expected").join(&case.name);
        if bless {
            fs::create_dir_all(golden.parent().unwrap()).unwrap();
            fs::write(&golden, &out.text).unwrap();
        } else {
            let want = fs::read_to_string(&golden)
                .unwrap_or_else(|_| panic!("{}: missing golden, run with PAMA_BLESS=1", case.name));
            assert_eq!(out.text, want, "{}: differs from golden", case.name);
        }
    }
}

#[test]
fn negatives_are_left_intact() {
    let rs = ruleset();
    for case in load_cases("negatives") {
        let out = rs.redact(&case.text, None);
        assert_eq!(out.text, case.text, "{}: negative was modified", case.name);
        assert_eq!(out.counts.secret + out.counts.pii, 0, "{}", case.name);
    }
}

#[test]
fn categories_choose_the_placeholder() {
    let rs = ruleset();
    let out = rs.redact("mail me at jane.doe@acme-corp.vn please", None);
    assert!(out.text.contains("[PII:email]"), "{}", out.text);
    assert_eq!(out.counts.pii, 1);
    assert_eq!(rs.category_of("email"), Some(Category::Pii));
}
