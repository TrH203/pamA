//! `pama scan [--since <dur>]`: watcher fallback for sessions the hooks missed.

use std::time::Duration;

use pama_core::capture::scan::{default_dirs, scan};
use serde_json::json;

use super::{parse_duration, Ctx};
use crate::Exit;

/// A transcript untouched for this long counts as an ended session.
pub const IDLE: Duration = Duration::from_secs(120);

pub fn run(ctx: &Ctx, since: Option<String>) -> anyhow::Result<Exit> {
    let since = match since.as_deref() {
        None => Duration::from_secs(7 * 86_400),
        Some(s) => match parse_duration(s) {
            Some(n) => Duration::from_secs(n),
            None => {
                eprintln!("error: --since takes a duration like 30m, 12h or 7d");
                return Ok(Exit::User);
            }
        },
    };
    let (claude, codex) = default_dirs();
    let r = scan(&ctx.store, claude.as_deref(), codex.as_deref(), since, IDLE)?;
    if r.enqueued > 0 {
        super::hook::spawn_drain();
    }
    ctx.print(&json!({ "seen": r.seen, "enqueued": r.enqueued }), || {
        format!(
            "{} ended sessions found, {} new queued for digesting",
            r.seen, r.enqueued
        )
    });
    Ok(Exit::Ok)
}
