//! Name-or-id resolution for library commands (spec 007): `pama tasks rename "Refund fee" …`
//! instead of looking ids up in `pama sync status` first.

use serde_json::Value;

use crate::Exit;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub name: String,
    /// Shown next to the name when several match (e.g. the project of a task).
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    One(usize),
    NotFound,
    Ambiguous(Vec<usize>),
}

fn norm(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn pick(matches: Vec<usize>) -> Option<Resolved> {
    match matches.len() {
        0 => None,
        1 => Some(Resolved::One(matches[0])),
        _ => Some(Resolved::Ambiguous(matches)),
    }
}

/// Resolve `query` against `cands`, most specific rule first: exact id, exact name
/// (case-insensitive), `context/name`, id prefix (≥ 4 characters), then every word of the query
/// in the name. The first rule with any match decides; several matches are ambiguous.
pub fn resolve(query: &str, cands: &[Candidate]) -> Resolved {
    let q = norm(query);
    if q.is_empty() {
        return Resolved::NotFound;
    }
    let all = || cands.iter().enumerate();
    if let Some(i) = cands.iter().position(|c| c.id == query.trim()) {
        return Resolved::One(i);
    }
    let rules: [&dyn Fn(&Candidate) -> bool; 4] = [
        &|c| norm(&c.name) == q,
        &|c| format!("{}/{}", norm(&c.context), norm(&c.name)) == q,
        &|c| q.len() >= 4 && c.id.to_lowercase().starts_with(&q),
        &|c| {
            let name = norm(&c.name);
            q.split(' ').all(|w| name.contains(w))
        },
    ];
    for rule in rules {
        if let Some(r) = pick(all().filter(|(_, c)| rule(c)).map(|(i, _)| i).collect()) {
            return r;
        }
    }
    Resolved::NotFound
}

/// Resolve or explain: prints "no <kind> matches" or the ambiguous candidates on stderr.
pub fn resolve_or_exit(kind: &str, query: &str, cands: &[Candidate]) -> Result<usize, Exit> {
    match resolve(query, cands) {
        Resolved::One(i) => Ok(i),
        Resolved::NotFound => {
            eprintln!("error: no {kind} matches \"{query}\"");
            Err(Exit::User)
        }
        Resolved::Ambiguous(ix) => {
            eprintln!(
                "error: \"{query}\" matches {} {kind}s; use one of these ids:",
                ix.len()
            );
            for i in ix.iter().take(20) {
                let c = &cands[*i];
                eprintln!(
                    "  {}  {}{}",
                    c.id,
                    c.name,
                    if c.context.is_empty() {
                        String::new()
                    } else {
                        format!("  ({})", c.context)
                    }
                );
            }
            Err(Exit::User)
        }
    }
}

/// Candidates from a JSON list: `id`, the name field and the context field.
pub fn candidates(items: &[Value], name: &str, context: &str) -> Vec<Candidate> {
    items
        .iter()
        .map(|v| Candidate {
            id: v["id"].as_str().unwrap_or_default().to_string(),
            name: v[name].as_str().unwrap_or_default().to_string(),
            context: v[context].as_str().unwrap_or_default().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(id: &str, name: &str, ctx: &str) -> Candidate {
        Candidate {
            id: id.into(),
            name: name.into(),
            context: ctx.into(),
        }
    }

    fn tasks() -> Vec<Candidate> {
        vec![
            c("01JA0000AAAA", "Refund shipping fee", "shop"),
            c("01JB0000BBBB", "feat/refund-worker", "shop"),
            c("01JC0000CCCC", "Fix flaky checkout test", "shop"),
            c("01JD0000DDDD", "main", "payment-sandbox"),
            c("01JE0000EEEE", "main", "shop"),
        ]
    }

    #[test]
    fn exact_id_and_name_win() {
        let t = tasks();
        assert_eq!(resolve("01JB0000BBBB", &t), Resolved::One(1));
        assert_eq!(resolve("refund SHIPPING   fee", &t), Resolved::One(0));
        assert_eq!(resolve("feat/refund-worker", &t), Resolved::One(1));
    }

    #[test]
    fn id_prefix_needs_four_characters() {
        let t = tasks();
        assert_eq!(resolve("01jc", &t), Resolved::One(2));
        assert_eq!(resolve("01J", &t), Resolved::NotFound);
        assert!(matches!(resolve("01J0", &t), Resolved::NotFound));
    }

    #[test]
    fn words_match_fuzzily_and_report_ambiguity() {
        let t = tasks();
        assert_eq!(resolve("flaky", &t), Resolved::One(2));
        assert_eq!(resolve("checkout flaky", &t), Resolved::One(2));
        assert_eq!(resolve("refund", &t), Resolved::Ambiguous(vec![0, 1]));
        assert_eq!(resolve("nothing like it", &t), Resolved::NotFound);
        assert_eq!(resolve("  ", &t), Resolved::NotFound);
    }

    #[test]
    fn context_disambiguates_same_names() {
        let t = tasks();
        assert_eq!(resolve("main", &t), Resolved::Ambiguous(vec![3, 4]));
        assert_eq!(resolve("shop/main", &t), Resolved::One(4));
        assert_eq!(resolve("payment-sandbox/main", &t), Resolved::One(3));
    }

    #[test]
    fn candidates_from_json() {
        let v = serde_json::json!([{ "id": "a", "name": "N", "project": "P" }]);
        let cs = candidates(v.as_array().unwrap(), "name", "project");
        assert_eq!(cs, vec![c("a", "N", "P")]);
    }
}
