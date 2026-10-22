//! Layer-1 redaction (Constitution II): deterministic rules + entropy, on the device, before any
//! model sees the text. Rules come from the shared `rules/` directory.

mod engine;
mod entropy;
mod rules;

pub use engine::{Counts, Redacted, RuleSet};
pub use entropy::shannon;
pub use rules::{Category, RuleError, StructuralAction, StructuralRule, RULE_FILES};
