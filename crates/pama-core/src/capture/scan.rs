//! Watcher fallback (research R1/R2): find ended sessions that hooks did not report.
//! A session counts as ended when it has not changed for `idle`. Every agent adapter that is
//! enabled (`pama agents`) is asked for its sessions.

use std::time::{Duration, SystemTime};

use crate::agents::{self, AgentAdapter, FoundSession};
use crate::digest::Agent;
use crate::store::{NewCapture, Store};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ScanReport {
    pub seen: usize,
    pub enqueued: usize,
}

/// `rollout-<ts>-<uuid>.jsonl` → `<uuid>` (kept for callers of the old path).
pub fn codex_session_id(file: &std::path::Path) -> String {
    agents::codex::session_id(file)
}

fn recent(updated: SystemTime, since: Duration, idle: Duration) -> bool {
    let age = SystemTime::now()
        .duration_since(updated)
        .unwrap_or_default();
    age <= since && age >= idle
}

/// Enqueue the sessions in `found` that ended between `since` and `idle` ago and are not known.
pub fn enqueue_found(
    store: &Store,
    found: Vec<(Agent, FoundSession)>,
    since: Duration,
    idle: Duration,
) -> crate::store::Result<ScanReport> {
    let mut report = ScanReport::default();
    let known: std::collections::HashSet<(String, String)> = store
        .captures(100_000)?
        .into_iter()
        .map(|c| (c.agent.as_str().to_string(), c.agent_session_id))
        .collect();
    let mut queued = std::collections::HashSet::new();
    for (agent, s) in found {
        if !recent(s.updated, since, idle) {
            continue;
        }
        report.seen += 1;
        let key = (agent.as_str().to_string(), s.session_id.clone());
        if known.contains(&key) || !queued.insert(key) {
            continue;
        }
        store.enqueue_capture(
            &NewCapture {
                agent,
                agent_session_id: s.session_id,
                transcript_path: s.location,
                cwd: None,
                reason: Some("scan".into()),
            },
            0,
        )?;
        report.enqueued += 1;
    }
    Ok(report)
}

/// Scan the given adapters (skipping agents turned off with `pama agents disable`).
pub fn scan_with(
    store: &Store,
    adapters: &[&dyn AgentAdapter],
    since: Duration,
    idle: Duration,
) -> crate::store::Result<ScanReport> {
    let mut found = Vec::new();
    for a in adapters {
        if !agents::enabled(store, a.agent()) {
            continue;
        }
        found.extend(a.sessions().into_iter().map(|s| (a.agent(), s)));
    }
    enqueue_found(store, found, since, idle)
}

/// Scan every agent pamA knows on this machine.
pub fn scan(store: &Store, since: Duration, idle: Duration) -> crate::store::Result<ScanReport> {
    scan_with(store, &agents::all(), since, idle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(id: &str, age_s: u64) -> FoundSession {
        FoundSession {
            session_id: id.into(),
            location: format!("/t/{id}.jsonl"),
            updated: SystemTime::now() - Duration::from_secs(age_s),
        }
    }

    #[test]
    fn enqueues_idle_unknown_sessions_once() {
        let s = Store::open_in_memory().unwrap();
        let day = Duration::from_secs(86_400);
        let idle = Duration::from_secs(120);
        let r = enqueue_found(
            &s,
            vec![
                (Agent::Cursor, found("a", 600)),
                (Agent::Cursor, found("a", 600)), // same transcript under two project slugs
                (Agent::OpenCode, found("b", 10)), // still active
                (Agent::Codex, found("c", 3 * 86_400)), // too old
            ],
            day,
            idle,
        )
        .unwrap();
        assert_eq!(
            r,
            ScanReport {
                seen: 2,
                enqueued: 1
            }
        );
        let again = enqueue_found(&s, vec![(Agent::Cursor, found("a", 600))], day, idle).unwrap();
        assert_eq!(again.enqueued, 0);
        assert_eq!(s.captures(10).unwrap()[0].agent, Agent::Cursor);
    }
}
