//! Summarize how an adapter reads a real transcript, without printing any content.
//! Usage: cargo run -p pama-core --example inspect_session -- <claude|codex> <path>

use std::collections::BTreeMap;
use std::path::Path;

use pama_core::session::{claude, codex};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (agent, path) = (args[1].as_str(), Path::new(&args[2]));
    let s = match agent {
        "claude" => claude::parse(path),
        _ => codex::parse(path),
    }
    .expect("parse");
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    let mut tools: BTreeMap<String, usize> = BTreeMap::new();
    let mut linked = 0;
    for e in &s.events {
        *kinds.entry(format!("{:?}", e.kind)).or_default() += 1;
        if let Some(t) = &e.tool {
            *tools.entry(t.clone()).or_default() += 1;
        }
        if e.kind == pama_core::session::EventKind::ToolResult && e.tool.is_some() {
            linked += 1;
        }
    }
    println!(
        "session_id={} cwd={} branch={} commit={} repo={} version={:?} times={} skipped_lines={}",
        !s.meta.session_id.is_empty(),
        s.meta.cwd.is_some(),
        s.meta.git_branch.is_some(),
        s.meta.git_commit.is_some(),
        s.meta.repo_url.is_some(),
        s.meta.agent_version,
        s.meta.started_at.is_some() && s.meta.ended_at.is_some(),
        s.skipped_lines
    );
    println!("events {kinds:?}\ntools {tools:?}\ntool results linked to calls: {linked}");
}
