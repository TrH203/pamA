//! Layer 1 over a normalized session: structural rules first (drop whole tool results such as a
//! `.env` read or an `env` dump), then regex rules over every text, command and path.

use super::event::{EventKind, NormalizedSession};
use crate::redact::{Category, Counts, RuleSet, StructuralAction};

pub fn redact_session(rs: &RuleSet, s: &mut NormalizedSession) -> Counts {
    let mut counts = Counts::default();
    for e in &mut s.events {
        if e.kind == EventKind::ToolResult {
            let tool = e.tool.as_deref().unwrap_or("");
            if let Some(rule) = rs
                .structural()
                .iter()
                .find(|r| r.matches(tool, e.path.as_deref(), e.command.as_deref()))
            {
                e.text = match rule.action {
                    StructuralAction::DropContent => format!("[DROPPED:{}]", rule.id),
                    StructuralAction::RedactAll => format!("[SECRET:{}]", rule.id),
                };
                counts.add(Category::Secret, &rule.id, 1);
            }
        }
        let path = e.path.clone();
        let r = rs.redact(&e.text, path.as_deref());
        e.text = r.text;
        counts.merge(&r.counts);
        if let Some(c) = &e.command {
            let r = rs.redact(c, None);
            e.command = Some(r.text);
            counts.merge(&r.counts);
        }
        if let Some(p) = &e.path {
            let r = rs.redact(p, None);
            e.path = Some(r.text);
            counts.merge(&r.counts);
        }
    }
    counts
}
