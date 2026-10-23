//! Loading the shared rule files (`rules/gitleaks.toml`, `rules/pama.toml`).
//!
//! Regexes are compiled as byte regexes with Unicode disabled so `\w`, `\d`, `\s` and `\b` keep
//! RE2's ASCII meaning (gitleaks parity, research R3).

use std::fs;
use std::path::Path;

use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::bytes::{Regex, RegexBuilder};
use serde::Deserialize;

/// Files loaded from a rules directory, in order.
pub const RULE_FILES: [&str; 2] = ["gitleaks.toml", "pama.toml"];

const SIZE_LIMIT: usize = 1 << 28;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    #[default]
    Secret,
    Pii,
}

impl Category {
    pub fn placeholder(self, id: &str) -> String {
        match self {
            Category::Secret => format!("[SECRET:{id}]"),
            Category::Pii => format!("[PII:{id}]"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RuleError {
    #[error("reading {0}: {1}")]
    Io(String, std::io::Error),
    #[error("parsing {0}: {1}")]
    Toml(String, toml::de::Error),
    #[error("rule {id}: invalid regex: {err}")]
    Regex { id: String, err: regex::Error },
    #[error("structural rule {id}: {msg}")]
    Structural { id: String, msg: String },
}

#[derive(Debug, Deserialize, Default)]
struct RawFile {
    allowlist: Option<RawAllowlist>,
    #[serde(default)]
    rules: Vec<RawRule>,
    #[serde(default)]
    structural: Vec<RawStructural>,
}

#[derive(Debug, Deserialize)]
struct RawRule {
    id: String,
    regex: Option<String>,
    path: Option<String>,
    #[serde(rename = "secretGroup")]
    secret_group: Option<usize>,
    entropy: Option<f64>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    allowlists: Vec<RawAllowlist>,
    #[serde(default)]
    category: Category,
}

#[derive(Debug, Deserialize, Default)]
struct RawAllowlist {
    #[serde(default)]
    regexes: Vec<String>,
    #[serde(default)]
    stopwords: Vec<String>,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(rename = "regexTarget")]
    regex_target: Option<String>,
    condition: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawStructural {
    id: String,
    #[serde(rename = "match")]
    matcher: RawStructuralMatch,
    action: StructuralAction,
}

#[derive(Debug, Deserialize)]
struct RawStructuralMatch {
    tool: String,
    #[serde(default)]
    path_glob: Vec<String>,
    command_regex: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegexTarget {
    Secret,
    Match,
    Line,
}

#[derive(Debug)]
pub struct Allowlist {
    pub regexes: Vec<Regex>,
    pub stopwords: Vec<String>,
    pub paths: Vec<Regex>,
    pub target: RegexTarget,
    pub and: bool,
}

impl Allowlist {
    /// gitleaks semantics: OR (default) = any criterion hits; AND = every non-empty criterion hits.
    pub fn allows(&self, secret: &str, matched: &str, line: &str, path: Option<&str>) -> bool {
        let mut hits = Vec::with_capacity(3);
        if !self.regexes.is_empty() {
            let target = match self.target {
                RegexTarget::Secret => secret,
                RegexTarget::Match => matched,
                RegexTarget::Line => line,
            };
            hits.push(self.regexes.iter().any(|r| r.is_match(target.as_bytes())));
        }
        if !self.stopwords.is_empty() {
            let lower = secret.to_lowercase();
            hits.push(self.stopwords.iter().any(|w| lower.contains(w.as_str())));
        }
        if !self.paths.is_empty() {
            hits.push(path.is_some_and(|p| self.paths.iter().any(|r| r.is_match(p.as_bytes()))));
        }
        if hits.is_empty() {
            return false;
        }
        if self.and {
            hits.iter().all(|h| *h)
        } else {
            hits.iter().any(|h| *h)
        }
    }
}

#[derive(Debug)]
pub struct Rule {
    pub id: String,
    pub regex: Option<Regex>,
    pub path: Option<Regex>,
    pub secret_group: Option<usize>,
    pub entropy: Option<f64>,
    /// Lower-cased prefilter keywords.
    pub keywords: Vec<String>,
    pub allowlists: Vec<Allowlist>,
    pub category: Category,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StructuralAction {
    DropContent,
    RedactAll,
}

#[derive(Debug)]
pub struct StructuralRule {
    pub id: String,
    /// Normalized tool name (`read`, `bash`, ...).
    pub tool: String,
    pub path_glob: Option<GlobSet>,
    pub command_regex: Option<Regex>,
    pub action: StructuralAction,
}

impl StructuralRule {
    pub fn matches(&self, tool: &str, path: Option<&str>, command: Option<&str>) -> bool {
        if !self.tool.eq_ignore_ascii_case(tool) {
            return false;
        }
        let path_ok = match (&self.path_glob, path) {
            (Some(g), Some(p)) => g.is_match(p),
            (Some(_), None) => false,
            (None, _) => true,
        };
        let cmd_ok = match (&self.command_regex, command) {
            (Some(r), Some(c)) => r.is_match(c.as_bytes()),
            (Some(_), None) => false,
            (None, _) => true,
        };
        path_ok && cmd_ok
    }
}

/// RE2 treats a `{` that does not start a valid repetition as a literal; Rust rejects it.
/// Escape such braces (outside character classes) so both engines read the same pattern.
pub(crate) fn re2_compat(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut i = 0;
    let mut in_class = false;
    let mut prev_repeatable = false;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            out.push(c);
            out.push(chars[i + 1]);
            i += 2;
            prev_repeatable = true;
            continue;
        }
        if in_class {
            out.push(c);
            if c == ']' {
                in_class = false;
                prev_repeatable = true;
            }
            i += 1;
            continue;
        }
        match c {
            '[' => {
                in_class = true;
                out.push(c);
                // A leading `]` or `^]` is literal inside the class.
                if chars.get(i + 1) == Some(&'^') {
                    out.push('^');
                    i += 1;
                }
                if chars.get(i + 1) == Some(&']') {
                    out.push(']');
                    i += 1;
                }
            }
            '{' => {
                let rest: String = chars[i..].iter().collect();
                let rep = rest.find('}').map(|end| &rest[1..end]).filter(|body| {
                    let mut parts = body.splitn(2, ',');
                    let a = parts.next().unwrap_or("");
                    let b = parts.next();
                    !a.is_empty()
                        && a.bytes().all(|x| x.is_ascii_digit())
                        && b.is_none_or(|b| b.bytes().all(|x| x.is_ascii_digit()))
                });
                match rep {
                    Some(body) if prev_repeatable => {
                        out.push('{');
                        out.push_str(body);
                        out.push('}');
                        i += body.chars().count() + 2;
                        prev_repeatable = false;
                        continue;
                    }
                    _ => out.push_str("\\{"),
                }
            }
            '}' => out.push_str("\\}"),
            _ => out.push(c),
        }
        prev_repeatable = !matches!(c, '(' | '|');
        i += 1;
    }
    out
}

pub(crate) fn compile(id: &str, pattern: &str) -> Result<Regex, RuleError> {
    RegexBuilder::new(&re2_compat(pattern))
        .unicode(false)
        .size_limit(SIZE_LIMIT)
        .dfa_size_limit(SIZE_LIMIT)
        .build()
        .map_err(|err| RuleError::Regex {
            id: id.to_string(),
            err,
        })
}

fn allowlist(id: &str, raw: RawAllowlist) -> Result<Allowlist, RuleError> {
    let target = match raw.regex_target.as_deref() {
        Some("match") => RegexTarget::Match,
        Some("line") => RegexTarget::Line,
        _ => RegexTarget::Secret,
    };
    Ok(Allowlist {
        regexes: raw
            .regexes
            .iter()
            .map(|r| compile(id, r))
            .collect::<Result<_, _>>()?,
        stopwords: raw.stopwords.iter().map(|s| s.to_lowercase()).collect(),
        paths: raw
            .paths
            .iter()
            .map(|r| compile(id, r))
            .collect::<Result<_, _>>()?,
        target,
        and: raw
            .condition
            .as_deref()
            .is_some_and(|c| c.eq_ignore_ascii_case("AND")),
    })
}

fn structural(raw: RawStructural) -> Result<StructuralRule, RuleError> {
    let path_glob = if raw.matcher.path_glob.is_empty() {
        None
    } else {
        let mut b = GlobSetBuilder::new();
        for g in &raw.matcher.path_glob {
            b.add(Glob::new(g).map_err(|e| RuleError::Structural {
                id: raw.id.clone(),
                msg: e.to_string(),
            })?);
        }
        Some(b.build().map_err(|e| RuleError::Structural {
            id: raw.id.clone(),
            msg: e.to_string(),
        })?)
    };
    let command_regex = raw
        .matcher
        .command_regex
        .as_deref()
        .map(|r| compile(&raw.id, r))
        .transpose()?;
    Ok(StructuralRule {
        id: raw.id,
        tool: raw.matcher.tool,
        path_glob,
        command_regex,
        action: raw.action,
    })
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub rules: Vec<Rule>,
    pub global: Vec<Allowlist>,
    pub structural: Vec<StructuralRule>,
}

pub fn parse(name: &str, src: &str, into: &mut Parsed) -> Result<(), RuleError> {
    let raw: RawFile = toml::from_str(src).map_err(|e| RuleError::Toml(name.to_string(), e))?;
    if let Some(a) = raw.allowlist {
        into.global.push(allowlist("global", a)?);
    }
    for r in raw.rules {
        let regex = r.regex.as_deref().map(|p| compile(&r.id, p)).transpose()?;
        let path = r.path.as_deref().map(|p| compile(&r.id, p)).transpose()?;
        let allowlists = r
            .allowlists
            .into_iter()
            .map(|a| allowlist(&r.id, a))
            .collect::<Result<_, _>>()?;
        into.rules.push(Rule {
            regex,
            path,
            secret_group: r.secret_group.filter(|g| *g > 0),
            entropy: r.entropy.filter(|e| *e > 0.0),
            keywords: r.keywords.iter().map(|k| k.to_lowercase()).collect(),
            allowlists,
            category: r.category,
            id: r.id,
        });
    }
    for s in raw.structural {
        into.structural.push(structural(s)?);
    }
    Ok(())
}

pub fn load_dir(dir: &Path) -> Result<Parsed, RuleError> {
    let mut parsed = Parsed::default();
    for f in RULE_FILES {
        let path = dir.join(f);
        let src =
            fs::read_to_string(&path).map_err(|e| RuleError::Io(path.display().to_string(), e))?;
        parse(f, &src, &mut parsed)?;
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::re2_compat;

    #[test]
    fn literal_braces_are_escaped() {
        assert_eq!(re2_compat(r"^\$(?:\d+|{\d+})$"), r"^\$(?:\d+|\{\d+\})$");
        assert_eq!(re2_compat(r"^\${(?:[A-Z_]+)}$"), r"^\$\{(?:[A-Z_]+)\}$");
    }

    #[test]
    fn repetitions_and_classes_are_kept() {
        assert_eq!(re2_compat(r"[a-z]{3,5}x{2}"), r"[a-z]{3,5}x{2}");
        assert_eq!(re2_compat(r"[{}]a{1,}"), r"[{}]a{1,}");
        assert_eq!(re2_compat(r"[]{]"), r"[]{]");
    }
}
