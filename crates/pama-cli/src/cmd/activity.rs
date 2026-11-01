//! `pama activity` and `pama logs` (spec 006): what happened to each captured session, attempt
//! by attempt, with coded errors and how to fix them.

use std::io::{BufRead, Seek, SeekFrom};
use std::time::Duration;

use pama_core::capture::errors::ErrorCode;
use pama_core::client::Api;
use pama_core::store::{now_ms, CaptureAttempt, CaptureStatus, CapturedSession};
use serde_json::{json, Value};

use super::{api_exit, Ctx};
use crate::{ActivityAction, Exit, LogSource};

/// Width of the id column; any unique prefix of 6+ characters is accepted back.
const ID_WIDTH: usize = 12;

pub fn short_id(id: &str) -> &str {
    &id[..id.len().min(ID_WIDTH)]
}

/// `42s ago`, `5m ago`, `3h ago`, `2d ago`.
pub fn ago(ms: i64) -> String {
    let s = ((now_ms() - ms) / 1000).max(0);
    match s {
        0..=59 => format!("{s}s ago"),
        60..=3_599 => format!("{}m ago", s / 60),
        3_600..=86_399 => format!("{}h ago", s / 3_600),
        _ => format!("{}d ago", s / 86_400),
    }
}

/// `in 5m` for a time in the future.
fn in_time(ms: i64) -> String {
    let s = ((ms - now_ms()) / 1000).max(0);
    match s {
        0..=59 => format!("in {s}s"),
        60..=3_599 => format!("in {}m", s / 60),
        _ => format!("in {}h", s / 3_600),
    }
}

pub fn duration(ms: Option<i64>) -> String {
    match ms {
        None => "-".into(),
        Some(ms) if ms < 1_000 => format!("{ms}ms"),
        Some(ms) => format!("{:.1}s", ms as f64 / 1000.0),
    }
}

/// Plain aligned table: header row, then rows; the last column is not padded.
pub fn table(header: &[&str], rows: &[Vec<String>]) -> String {
    let n = header.len();
    let mut widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
    for r in rows {
        for (i, c) in r.iter().enumerate().take(n) {
            widths[i] = widths[i].max(c.chars().count());
        }
    }
    let line = |cells: Vec<String>| {
        let mut out = String::new();
        for (i, c) in cells.iter().enumerate() {
            if i + 1 == n {
                out.push_str(c);
            } else {
                out.push_str(&format!("{c:<w$}  ", w = widths[i]));
            }
        }
        out.trim_end().to_string()
    };
    let mut out = vec![line(header.iter().map(|h| h.to_string()).collect())];
    out.extend(rows.iter().map(|r| line(r.clone())));
    out.join("\n")
}

fn project_of(c: &CapturedSession) -> String {
    c.cwd
        .as_deref()
        .and_then(|p| p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next())
        .unwrap_or("-")
        .to_string()
}

/// One attempt as a stage timeline: `parsed → redacted → ✗ provider_unreachable`.
pub fn timeline(a: &CaptureAttempt) -> String {
    let order = ["parsed", "redacted", "submitted"];
    let reached = order
        .iter()
        .position(|s| *s == a.stage)
        .map_or(0, |i| i + 1);
    let mut parts: Vec<String> = order[..reached].iter().map(|s| s.to_string()).collect();
    match a.outcome.as_deref() {
        None => parts.push("…".into()),
        Some("succeeded") => parts.push("✓ stored".into()),
        Some("queued") => parts.push("✓ queued for server".into()),
        Some("skipped") => parts.push(format!(
            "skipped: {}",
            a.error_code.as_deref().unwrap_or("-")
        )),
        Some(_) => parts.push(format!("✗ {}", a.error_code.as_deref().unwrap_or("error"))),
    }
    parts.join(" → ")
}

fn status_label(c: &CapturedSession) -> String {
    match c.status {
        CaptureStatus::Detected if c.attempts > 0 => {
            format!("retrying {}", in_time(c.next_attempt_at))
        }
        CaptureStatus::Detected => "queued".into(),
        CaptureStatus::Redacting | CaptureStatus::Digesting => "running".into(),
        CaptureStatus::ReadyForReview => "drafted".into(),
        s => s.as_str().into(),
    }
}

fn capture_json(c: &CapturedSession, attempts: &[CaptureAttempt]) -> Value {
    let hint = c
        .error_code
        .as_deref()
        .and_then(ErrorCode::parse)
        .map(|e| e.hint());
    json!({
        "id": c.id,
        "agent": c.agent,
        "agent_session_id": c.agent_session_id,
        "project": project_of(c),
        "cwd": c.cwd,
        "git_branch": c.git_branch,
        "status": c.status,
        "error_code": c.error_code,
        "error": c.error,
        "fix": hint,
        "digest_id": c.digest_id,
        "ended_at": c.ended_at,
        "processed_at": c.processed_at,
        "next_attempt_at": (c.status == CaptureStatus::Detected).then_some(c.next_attempt_at),
        "attempts": attempts,
    })
}

fn list(ctx: &Ctx, failed: bool, limit: usize) -> anyhow::Result<Vec<CapturedSession>> {
    Ok(if failed {
        ctx.store
            .captures_with_status(CaptureStatus::Failed, limit)?
    } else {
        ctx.store.captures(limit)?
    })
}

fn print_list(ctx: &Ctx, captures: &[CapturedSession]) -> anyhow::Result<()> {
    let mut items = Vec::new();
    let mut rows = Vec::new();
    for c in captures {
        let attempts = ctx.store.attempts(&c.id)?;
        let last = attempts.last();
        rows.push(vec![
            short_id(&c.id).to_string(),
            c.agent.as_str().replace("claude_code", "claude"),
            project_of(c),
            ago(c.ended_at),
            status_label(c),
            attempts.len().to_string(),
            last.map(timeline).unwrap_or_else(|| "-".into()),
        ]);
        items.push(capture_json(c, &attempts));
    }
    ctx.print(&json!({ "captures": items }), || {
        if rows.is_empty() {
            return "No captured sessions yet. Run `pama init` in a project, or `pama scan`."
                .into();
        }
        let mut out = table(
            &[
                "ID",
                "AGENT",
                "PROJECT",
                "ENDED",
                "STATUS",
                "TRIES",
                "LAST ATTEMPT",
            ],
            &rows,
        );
        if let Some(c) = captures.iter().find(|c| c.status == CaptureStatus::Failed) {
            out.push_str(&format!(
                "\n\nDetails: `pama activity show {}`. Retry: `pama activity retry --all-failed`.",
                short_id(&c.id)
            ));
        }
        out
    });
    Ok(())
}

/// Print attempts as they start and end until interrupted.
fn follow(ctx: &Ctx) -> anyhow::Result<Exit> {
    let mut since = now_ms();
    let mut seen: std::collections::HashMap<String, Option<String>> = Default::default();
    if !ctx.json {
        println!("Following captures (Ctrl-C to stop)…");
    }
    loop {
        for a in ctx.store.attempts_since(since - 1, 200)? {
            since = since.max(a.ended_at.unwrap_or(a.started_at));
            if seen.get(&a.id) == Some(&a.outcome) {
                continue;
            }
            seen.insert(a.id.clone(), a.outcome.clone());
            if ctx.json {
                println!("{}", serde_json::to_string(&a)?);
                continue;
            }
            let c = ctx.store.capture(&a.capture_id).ok();
            let mut line = format!(
                "{}  {}  #{}  {}  {}",
                pama_core::capture::worker::rfc3339(
                    std::time::UNIX_EPOCH
                        + Duration::from_millis(a.ended_at.unwrap_or(a.started_at) as u64)
                ),
                short_id(&a.capture_id),
                a.attempt,
                c.as_ref().map(project_of).unwrap_or_default(),
                timeline(&a),
            );
            if a.outcome.is_some() {
                line.push_str(&format!(" ({})", duration(a.duration_ms)));
            }
            if let Some(code) = a.error_code.as_deref().and_then(ErrorCode::parse) {
                if a.outcome.as_deref() != Some("skipped") {
                    line.push_str(&format!(
                        "\n    {}\n    → {}",
                        a.error_detail.as_deref().unwrap_or(""),
                        code.hint()
                    ));
                }
            }
            println!("{line}");
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// The server's run for an attempt, if the server is reachable.
fn server_run(ctx: &Ctx, run_id: &str) -> Option<Value> {
    let api = Api::resolve(&ctx.store, "cli", ctx.server.as_deref()).ok()?;
    api.get(&format!("/v1/activity/{run_id}"), "activity.show")
        .ok()
        .map(|v| v["run"].clone())
}

fn show(ctx: &Ctx, id: &str) -> anyhow::Result<Exit> {
    let c = match ctx.store.find_capture(id) {
        Ok(c) => c,
        // Not a capture of this device: maybe a server run id.
        Err(_) => {
            let api = match ctx.api() {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("error: no capture `{id}` on this device");
                    return Ok(api_exit(&e));
                }
            };
            return match api.get(&format!("/v1/activity/{id}"), "activity.show") {
                Ok(v) => {
                    ctx.print(&v, || run_text(&v["run"]));
                    Ok(Exit::Ok)
                }
                Err(e) => {
                    eprintln!("error: no capture or server run `{id}`");
                    Ok(api_exit(&e))
                }
            };
        }
    };
    let attempts = ctx.store.attempts(&c.id)?;
    let run = attempts
        .iter()
        .rev()
        .find_map(|a| a.run_id.as_deref())
        .and_then(|r| server_run(ctx, r));
    let mut v = capture_json(&c, &attempts);
    v["server_run"] = run.clone().unwrap_or(Value::Null);
    ctx.print(&v, || {
        let mut out = format!(
            "Capture {}\n  agent     {} session {}\n  project   {}{}\n  status    {}\n  ended     {}",
            c.id,
            c.agent.as_str(),
            c.agent_session_id,
            project_of(&c),
            c.git_branch
                .as_deref()
                .map(|b| format!(" ({b})"))
                .unwrap_or_default(),
            status_label(&c),
            ago(c.ended_at),
        );
        if let Some(d) = &c.digest_id {
            out.push_str(&format!("\n  digest    {d}"));
        }
        if let (Some(code), Some(msg)) = (&c.error_code, &c.error) {
            out.push_str(&format!("\n  last error {code}: {msg}"));
            if let Some(h) = ErrorCode::parse(code).map(|e| e.hint()) {
                out.push_str(&format!("\n  → {h}"));
            }
        }
        out.push_str("\n\nAttempts");
        if attempts.is_empty() {
            out.push_str("\n  none yet");
        }
        for a in &attempts {
            out.push_str(&format!(
                "\n  #{} {}  {}  ({})",
                a.attempt,
                ago(a.started_at),
                timeline(a),
                duration(a.duration_ms)
            ));
            if let Some(m) = a.error_detail.as_deref().filter(|_| a.outcome.as_deref() != Some("skipped")) {
                out.push_str(&format!("\n      {m}"));
            }
            let who: Vec<&str> = [a.role.as_deref(), a.provider.as_deref(), a.model.as_deref()]
                .into_iter()
                .flatten()
                .collect();
            if !who.is_empty() {
                out.push_str(&format!("\n      model: {}", who.join(" · ")));
            }
            if let Some(r) = &a.run_id {
                out.push_str(&format!("\n      server run {r}"));
            }
        }
        if let Some(r) = &run {
            out.push_str("\n\nServer run\n");
            out.push_str(&run_text(r));
        }
        out
    });
    Ok(Exit::Ok)
}

/// A server run (`GET /v1/activity/:id`) as text.
pub fn run_text(r: &Value) -> String {
    let s = |k: &str| r[k].as_str().unwrap_or("-").to_string();
    let stages = ["received", "drafted", "classified", "embedded", "stored"];
    let reached = stages.iter().position(|x| *x == s("stage")).unwrap_or(0);
    let mut tl: Vec<String> = stages[..=reached].iter().map(|x| x.to_string()).collect();
    match s("status").as_str() {
        "failed" => tl.push(format!("✗ {}", s("error_code"))),
        "succeeded" => {}
        other => tl.push(format!("({other})")),
    }
    let mut out = format!(
        "  run       {} ({}, {} attempt(s))\n  stages    {}\n  status    {}  {}",
        s("id"),
        s("kind"),
        r["attempts"].as_i64().unwrap_or(1),
        tl.join(" → "),
        s("status"),
        duration(r["duration_ms"].as_i64()),
    );
    if let Some(m) = r["error_message"].as_str() {
        out.push_str(&format!("\n  error     {m}"));
    }
    if r["resumable"].as_bool() == Some(true) {
        out.push_str(&format!(
            "\n  → the draft was kept: `pama activity retry {}` resumes from embedding",
            s("id")
        ));
    }
    if let Some(d) = r["digest_id"].as_str() {
        out.push_str(&format!("\n  digest    {d}"));
    }
    out
}

fn retry(ctx: &Ctx, id: Option<String>, all_failed: bool) -> anyhow::Result<Exit> {
    if all_failed {
        let n = ctx.store.retry_all_failed()?;
        if n > 0 {
            super::hook::spawn_drain();
        }
        ctx.print(&json!({ "queued": n }), || {
            if n == 0 {
                "No failed captures.".into()
            } else {
                format!(
                    "Queued {n} capture(s) for another try. Watch with `pama activity --follow`."
                )
            }
        });
        return Ok(Exit::Ok);
    }
    let Some(id) = id else {
        eprintln!("error: give a capture id or --all-failed");
        return Ok(Exit::User);
    };
    match ctx.store.find_capture(&id) {
        Ok(c) => {
            if !ctx.store.retry_capture(&c.id)? {
                eprintln!(
                    "error: capture {} is {}, only failed or skipped captures can be retried",
                    short_id(&c.id),
                    c.status.as_str()
                );
                return Ok(Exit::User);
            }
            super::hook::spawn_drain();
            ctx.print(&json!({ "queued": 1, "id": c.id }), || {
                format!(
                    "Queued {} for another try. Watch with `pama activity --follow`.",
                    short_id(&c.id)
                )
            });
            Ok(Exit::Ok)
        }
        // A server run (its draft was kept on the server).
        Err(_) => {
            let api = match ctx.api() {
                Ok(a) => a,
                Err(e) => return Ok(api_exit(&e)),
            };
            match api.post_slow(
                &format!("/v1/activity/{id}/retry"),
                "activity.retry",
                &json!({}),
            ) {
                Ok(v) => {
                    ctx.print(&v, || {
                        format!(
                            "Run {id} succeeded: digest {} ({})",
                            v["digest_id"].as_str().unwrap_or("-"),
                            v["status"].as_str().unwrap_or("-")
                        )
                    });
                    Ok(Exit::Ok)
                }
                Err(e) => Ok(api_exit(&e)),
            }
        }
    }
}

pub fn run(
    ctx: &Ctx,
    failed: bool,
    follow_: bool,
    limit: usize,
    action: Option<ActivityAction>,
) -> anyhow::Result<Exit> {
    match action {
        Some(ActivityAction::Show { id }) => show(ctx, &id),
        Some(ActivityAction::Retry { id, all_failed }) => retry(ctx, id, all_failed),
        None => {
            print_list(ctx, &list(ctx, failed, limit)?)?;
            if follow_ {
                if !ctx.json {
                    println!();
                }
                return follow(ctx);
            }
            Ok(Exit::Ok)
        }
    }
}

// --- logs -------------------------------------------------------------------------------------

fn tail_lines(path: &std::path::Path, n: usize) -> std::io::Result<(Vec<String>, u64)> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    // Read at most the last 256 KiB.
    let start = len.saturating_sub(256 * 1024);
    f.seek(SeekFrom::Start(start))?;
    let mut lines: Vec<String> = std::io::BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // partial line
    }
    let skip = lines.len().saturating_sub(n);
    Ok((lines.split_off(skip), len))
}

pub fn logs(ctx: &Ctx, source: LogSource, lines: usize, follow_: bool) -> anyhow::Result<Exit> {
    let path = match source {
        LogSource::Device => pama_core::paths::log_file(),
        LogSource::Server => pama_core::paths::pama_home().join("server.log"),
    };
    let (tail, mut pos) = match tail_lines(&path, lines) {
        Ok(x) => x,
        Err(_) => {
            ctx.print(&json!({ "path": path, "lines": [] }), || {
                format!("No log yet at {}.", path.display())
            });
            if !follow_ {
                return Ok(Exit::Ok);
            }
            (Vec::new(), 0)
        }
    };
    if ctx.json {
        if !follow_ {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({ "path": path, "lines": tail }))?
            );
            return Ok(Exit::Ok);
        }
        for l in &tail {
            println!("{}", serde_json::to_string(&json!({ "line": l }))?);
        }
    } else {
        for l in &tail {
            println!("{l}");
        }
    }
    if !follow_ {
        return Ok(Exit::Ok);
    }
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let Ok(mut f) = std::fs::File::open(&path) else {
            continue;
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < pos {
            pos = 0; // truncated or rotated
        }
        if len == pos {
            continue;
        }
        f.seek(SeekFrom::Start(pos))?;
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut f, &mut buf)?;
        pos = len;
        for l in buf.lines() {
            if ctx.json {
                println!("{}", serde_json::to_string(&json!({ "line": l }))?);
            } else {
                println!("{l}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(stage: &str, outcome: Option<&str>, code: Option<&str>) -> CaptureAttempt {
        CaptureAttempt {
            id: "a".into(),
            capture_id: "c".into(),
            attempt: 1,
            stage: stage.into(),
            outcome: outcome.map(str::to_string),
            started_at: 0,
            ended_at: None,
            duration_ms: None,
            error_code: code.map(str::to_string),
            error_detail: None,
            role: None,
            provider: None,
            model: None,
            digest_id: None,
            run_id: None,
        }
    }

    #[test]
    fn timelines() {
        assert_eq!(
            timeline(&attempt(
                "redacted",
                Some("retry"),
                Some("provider_unreachable")
            )),
            "parsed → redacted → ✗ provider_unreachable"
        );
        assert_eq!(
            timeline(&attempt("submitted", Some("succeeded"), None)),
            "parsed → redacted → submitted → ✓ stored"
        );
        assert_eq!(
            timeline(&attempt("parsed", Some("skipped"), Some("empty_session"))),
            "parsed → skipped: empty_session"
        );
        assert_eq!(timeline(&attempt("started", None, None)), "…");
    }

    #[test]
    fn tables_align() {
        let t = table(
            &["ID", "STATUS", "NOTE"],
            &[
                vec!["1".into(), "failed".into(), "x".into()],
                vec!["22".into(), "ok".into(), "".into()],
            ],
        );
        assert_eq!(t, "ID  STATUS  NOTE\n1   failed  x\n22  ok");
    }

    #[test]
    fn durations() {
        assert_eq!(duration(None), "-");
        assert_eq!(duration(Some(450)), "450ms");
        assert_eq!(duration(Some(12_345)), "12.3s");
    }

    #[test]
    fn server_run_text() {
        let r = json!({
            "id": "R1", "kind": "transcript", "stage": "classified", "status": "failed",
            "error_code": "provider_unreachable", "error_message": "Embedding model (ollama bge-m3) is unreachable.",
            "resumable": true, "attempts": 1, "duration_ms": 1200
        });
        let t = run_text(&r);
        assert!(t.contains("received → drafted → classified → ✗ provider_unreachable"));
        assert!(t.contains("pama activity retry R1"));
    }
}
