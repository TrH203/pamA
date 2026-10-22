//! The Layer-1 redactor: applies every rule in file order to the current text and replaces the
//! secret part of each finding with a typed placeholder. The TypeScript port in
//! `apps/server/src/safety/rules.ts` follows the same algorithm and shares golden outputs.

use std::collections::BTreeMap;
use std::path::Path;

use super::entropy::shannon;
use super::rules::{self, Allowlist, Category, Rule, RuleError, StructuralRule};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Counts {
    pub secret: u32,
    pub pii: u32,
    pub by_rule: BTreeMap<String, u32>,
}

impl Counts {
    pub fn add(&mut self, category: Category, id: &str, n: u32) {
        if n == 0 {
            return;
        }
        match category {
            Category::Secret => self.secret += n,
            Category::Pii => self.pii += n,
        }
        *self.by_rule.entry(id.to_string()).or_default() += n;
    }

    pub fn merge(&mut self, other: &Counts) {
        self.secret += other.secret;
        self.pii += other.pii;
        for (k, v) in &other.by_rule {
            *self.by_rule.entry(k.clone()).or_default() += v;
        }
    }

    pub fn total(&self) -> u32 {
        self.secret + self.pii
    }
}

#[derive(Debug, Clone)]
pub struct Redacted {
    pub text: String,
    pub counts: Counts,
}

#[derive(Debug)]
pub struct RuleSet {
    rules: Vec<Rule>,
    global: Vec<Allowlist>,
    structural: Vec<StructuralRule>,
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Byte ranges of placeholders already in `s` (`[SECRET:id]`, `[PII:id]`). Findings that touch
/// one are skipped so a placeholder is never redacted again.
fn placeholder_ranges(s: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = s[from..].find('[').map(|i| i + from) {
        let rest = &s[i..];
        let tag = if rest.starts_with("[SECRET:") {
            8
        } else if rest.starts_with("[PII:") {
            5
        } else {
            from = i + 1;
            continue;
        };
        match rest[tag..].find(']') {
            Some(j)
                if rest[tag..tag + j]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
            {
                out.push((i, i + tag + j + 1));
                from = i + tag + j + 1;
            }
            _ => from = i + 1,
        }
    }
    out
}

fn line_of(s: &str, start: usize, end: usize) -> &str {
    let a = s[..start].rfind('\n').map_or(0, |i| i + 1);
    let b = s[end..].find('\n').map_or(s.len(), |i| end + i);
    &s[a..b]
}

impl RuleSet {
    pub fn load_dir(dir: &Path) -> Result<Self, RuleError> {
        Ok(Self::from_parsed(rules::load_dir(dir)?))
    }

    /// Build from in-memory TOML sources, in order (name, contents).
    pub fn from_sources(sources: &[(&str, &str)]) -> Result<Self, RuleError> {
        let mut parsed = rules::Parsed::default();
        for (name, src) in sources {
            rules::parse(name, src, &mut parsed)?;
        }
        Ok(Self::from_parsed(parsed))
    }

    fn from_parsed(p: rules::Parsed) -> Self {
        Self {
            rules: p.rules,
            global: p.global,
            structural: p.structural,
        }
    }

    pub fn regex_rule_count(&self) -> usize {
        self.rules.iter().filter(|r| r.regex.is_some()).count()
    }

    pub fn structural_count(&self) -> usize {
        self.structural.len()
    }

    pub fn rule_ids(&self) -> impl Iterator<Item = &str> {
        self.rules
            .iter()
            .map(|r| r.id.as_str())
            .chain(self.structural.iter().map(|s| s.id.as_str()))
    }

    pub fn category_of(&self, id: &str) -> Option<Category> {
        self.rules.iter().find(|r| r.id == id).map(|r| r.category)
    }

    pub fn structural(&self) -> &[StructuralRule] {
        &self.structural
    }

    /// Redact `text`. `path` is the file the text came from, when known (enables path rules).
    pub fn redact(&self, text: &str, path: Option<&str>) -> Redacted {
        let mut cur = text.to_string();
        let mut lower = cur.to_lowercase();
        let mut counts = Counts::default();
        for rule in &self.rules {
            let Some(re) = &rule.regex else { continue };
            if let Some(pr) = &rule.path {
                if !path.is_some_and(|p| pr.is_match(p.as_bytes())) {
                    continue;
                }
            }
            if !rule.keywords.is_empty()
                && !rule.keywords.iter().any(|k| lower.contains(k.as_str()))
            {
                continue;
            }
            let spans = self.find(rule, re, &cur, path);
            if spans.is_empty() {
                continue;
            }
            let placeholder = rule.category.placeholder(&rule.id);
            let mut out = String::with_capacity(cur.len());
            let mut last = 0;
            for (a, b) in &spans {
                out.push_str(&cur[last..*a]);
                out.push_str(&placeholder);
                last = *b;
            }
            out.push_str(&cur[last..]);
            counts.add(rule.category, &rule.id, spans.len() as u32);
            cur = out;
            lower = cur.to_lowercase();
        }
        Redacted { text: cur, counts }
    }

    fn find(
        &self,
        rule: &Rule,
        re: &regex::bytes::Regex,
        text: &str,
        path: Option<&str>,
    ) -> Vec<(usize, usize)> {
        let mut spans: Vec<(usize, usize)> = Vec::new();
        let existing = placeholder_ranges(text);
        for caps in re.captures_iter(text.as_bytes()) {
            let whole = caps.get(0).expect("group 0");
            let secret = match rule.secret_group {
                Some(g) => match caps.get(g) {
                    Some(m) => m,
                    None => continue,
                },
                None => (1..caps.len())
                    .filter_map(|i| caps.get(i))
                    .find(|m| !m.is_empty())
                    .unwrap_or(whole),
            };
            if secret.is_empty() {
                continue;
            }
            let (a, b) = (
                floor_boundary(text, secret.start()),
                ceil_boundary(text, secret.end()),
            );
            let (wa, wb) = (
                floor_boundary(text, whole.start()),
                ceil_boundary(text, whole.end()),
            );
            if existing.iter().any(|(pa, pb)| a < *pb && *pa < b) {
                continue;
            }
            let secret_str = &text[a..b];
            if let Some(min) = rule.entropy {
                if shannon(secret_str) <= min {
                    continue;
                }
                if rule.id.starts_with("generic") && !secret_str.bytes().any(|c| c.is_ascii_digit())
                {
                    continue;
                }
            }
            let matched = &text[wa..wb];
            let line = line_of(text, wa, wb);
            let allowed = self
                .global
                .iter()
                .chain(rule.allowlists.iter())
                .any(|al| al.allows(secret_str, matched, line, path));
            if allowed {
                continue;
            }
            if spans.last().is_some_and(|(_, end)| a < *end) {
                continue;
            }
            spans.push((a, b));
        }
        spans
    }
}
