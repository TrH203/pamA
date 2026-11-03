//! `pama scan [--since <dur>]`: watcher fallback for sessions the hooks missed.

use std::time::Duration;

use pama_core::capture::scan::scan;
use serde_json::json;

use super::{parse_duration, Ctx};
use crate::Exit;

/// Setting holding the last scan's result (`{at, seen, enqueued}`) for `pama doctor --report`.
pub const KEY_LAST_SCAN: &str = "scan.last";

/// A transcript untouched for this long counts as an ended session.
pub const IDLE: Duration = Duration::from_secs(120);

pub fn run(ctx: &Ctx, since: Option<String>) -> anyhow::Result<Exit> {
    let since = match since.as_deref() {
        None => Duration::from_secs(7 * 86_400),
        Some(s) => match parse_duration(s) {
            Some(n) => Duration::from_secs(n),
            None => {
                crate::fail!("usage", "--since takes a duration like 30m, 12h or 7d");
                return Ok(Exit::User);
            }
        },
    };
    let spin = crate::ui::spinner(ctx.json, "scanning agent transcripts…");
    let r = scan(&ctx.store, since, IDLE);
    spin.finish();
    let r = r?;
    let at = pama_core::store::now_ms();
    ctx.store.set_setting(
        KEY_LAST_SCAN,
        &json!({ "at": at, "seen": r.seen, "enqueued": r.enqueued }).to_string(),
    )?;
    if r.enqueued > 0 {
        super::hook::spawn_drain();
    }
    ctx.print(&json!({ "seen": r.seen, "enqueued": r.enqueued }), || {
        format!(
            "{} {} ended sessions found, {} new queued for digesting",
            crate::ui::Mark::Ok.sym(),
            r.seen,
            r.enqueued
        )
    });
    Ok(Exit::Ok)
}
