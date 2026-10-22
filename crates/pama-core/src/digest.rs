//! `SessionDigest`: the shared contract between pama-core, the server and sync.
//!
//! Mirrors `packages/types/schema/session-digest.schema.json`. Serde rejects unknown fields;
//! [`SessionDigest::validate`] enforces the limits serde cannot express.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    ClaudeCode,
    Codex,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensitivityLabel {
    BusinessSensitive,
    Infra,
    Customer,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commits: Option<Vec<String>>,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DigestSource {
    pub agent: Agent,
    pub agent_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
    /// Normalized repo remote or path hash; never an absolute local path.
    pub project_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub ended_at: String,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub id: u32,
    pub what: String,
    pub why: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<SensitivityLabel>>,
}

#[typeshare]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Redactions {
    pub secret: u32,
    pub pii: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_rule: Option<HashMap<String, u32>>,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub produced_at: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionDigest {
    pub schema_version: u32,
    pub source: DigestSource,
    pub goal: String,
    pub decisions: Vec<Decision>,
    pub outcome: String,
    pub open_items: Vec<String>,
    pub modules: Vec<String>,
    pub redactions: Redactions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Provenance>,
}

#[derive(Debug, thiserror::Error)]
pub enum DigestError {
    #[error("invalid digest JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid digest: {0}")]
    Invalid(String),
}

fn check_len(field: &str, s: &str, min: usize, max: usize) -> Result<(), DigestError> {
    let n = s.chars().count();
    if n < min || n > max {
        return Err(DigestError::Invalid(format!(
            "{field} length {n} not in {min}..={max}"
        )));
    }
    Ok(())
}

fn check_items(
    field: &str,
    items: &[String],
    max_items: usize,
    max_len: usize,
) -> Result<(), DigestError> {
    if items.len() > max_items {
        return Err(DigestError::Invalid(format!(
            "{field} has {} items, max {max_items}",
            items.len()
        )));
    }
    for s in items {
        check_len(field, s, 0, max_len)?;
    }
    Ok(())
}

fn is_commit(s: &str) -> bool {
    (7..=40).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl SessionDigest {
    pub const SCHEMA_VERSION: u32 = 1;

    /// Parse and validate.
    pub fn from_json(raw: &str) -> Result<Self, DigestError> {
        let d: SessionDigest = serde_json::from_str(raw)?;
        d.validate()?;
        Ok(d)
    }

    pub fn validate(&self) -> Result<(), DigestError> {
        if self.schema_version != Self::SCHEMA_VERSION {
            return Err(DigestError::Invalid(format!(
                "schema_version must be {}",
                Self::SCHEMA_VERSION
            )));
        }
        let s = &self.source;
        check_len("source.agent_session_id", &s.agent_session_id, 1, 128)?;
        if let Some(v) = &s.agent_version {
            check_len("source.agent_version", v, 0, 64)?;
        }
        check_len("source.project_key", &s.project_key, 0, 256)?;
        if let Some(b) = &s.bundle_key {
            check_len("source.bundle_key", b, 0, 256)?;
        }
        if let Some(git) = &s.git {
            if let Some(b) = &git.branch {
                check_len("source.git.branch", b, 0, 256)?;
            }
            if let Some(commits) = &git.commits {
                if commits.len() > 50 {
                    return Err(DigestError::Invalid("source.git.commits max 50".into()));
                }
                if let Some(bad) = commits.iter().find(|c| !is_commit(c)) {
                    return Err(DigestError::Invalid(format!("bad commit hash {bad:?}")));
                }
            }
        }
        check_len("goal", &self.goal, 1, 1000)?;
        if self.decisions.len() > 30 {
            return Err(DigestError::Invalid("decisions max 30".into()));
        }
        for d in &self.decisions {
            if d.id < 1 {
                return Err(DigestError::Invalid("decision id must be >= 1".into()));
            }
            check_len("decision.what", &d.what, 1, 1000)?;
            check_len("decision.why", &d.why, 0, 1000)?;
            if let Some(alts) = &d.alternatives {
                check_items("decision.alternatives", alts, 10, 500)?;
            }
            if let Some(labels) = &d.labels {
                let mut seen = std::collections::HashSet::new();
                if !labels.iter().all(|l| seen.insert(*l)) {
                    return Err(DigestError::Invalid(
                        "decision.labels must be unique".into(),
                    ));
                }
            }
        }
        check_len("outcome", &self.outcome, 0, 1000)?;
        check_items("open_items", &self.open_items, 20, 500)?;
        check_items("modules", &self.modules, 30, 100)?;
        Ok(())
    }
}
