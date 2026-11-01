//! `pama status` (spec 006), also what bare `pama` prints: where data goes, the effective
//! models, the digest pipeline (running, awaiting review, failed, latest error with its fix) and
//! sync. Reads the device store; asks the server only if it is already running.

use pama_core::capture::errors::ErrorCode;
use pama_core::client::Api;
use pama_core::draft::llm::ModelConfig;
use pama_core::remote::{self, Mode};
use serde_json::{json, Value};

use super::activity::{ago, short_id};
use super::Ctx;
use crate::Exit;

const ROLES: [&str; 3] = ["chat", "small", "embed"];

/// The server this device works with, if reachable without starting anything.
fn server_api<'s>(ctx: &'s Ctx, remote_mode: bool) -> Option<Api<'s>> {
    if remote_mode || ctx.server.is_some() {
        pama_core::secrets::init_platform_store();
        return Api::resolve(&ctx.store, "cli", ctx.server.as_deref()).ok();
    }
    super::server::running(&ctx.store)?;
    Api::connect(&ctx.store, "cli").ok()
}

fn models_json(api: Option<&Api<'_>>) -> Value {
    let Some(v) = api.and_then(|a| a.get("/v1/models/settings", "status").ok()) else {
        return Value::Null;
    };
    let mut out = serde_json::Map::new();
    for r in ROLES {
        let x = &v["roles"][r];
        if x.is_null() {
            continue;
        }
        out.insert(
            r.into(),
            json!({
                "provider": x["provider"],
                "model": x["model"],
                "local": x["local"],
                "origin": x["source"],
                "verified": x["verified"],
            }),
        );
    }
    Value::Object(out)
}

pub fn run(ctx: &Ctx) -> anyhow::Result<Exit> {
    let store = &ctx.store;
    let mode = remote::mode(store);
    let remote_mode = mode == Mode::Remote;
    let api = server_api(ctx, remote_mode);
    let server_url = match (&api, remote_mode) {
        (Some(a), _) => Some(a.base_url().to_string()),
        (None, true) => remote::default_server(store),
        (None, false) => None,
    };
    let reachable = api.as_ref().is_some_and(|a| a.healthy());

    let models = if reachable {
        models_json(api.as_ref())
    } else {
        Value::Null
    };
    let device_model = remote_mode.then(|| {
        let m = ModelConfig::from_store(store);
        json!({ "provider": m.provider, "model": m.model, "local": m.is_local() })
    });

    let counts = store.capture_counts()?;
    let latest = store.latest_failed_attempt()?;
    let latest_json = latest.as_ref().map(|a| {
        let code = a.error_code.as_deref().and_then(ErrorCode::parse);
        json!({
            "capture_id": a.capture_id,
            "code": a.error_code,
            "message": a.error_detail,
            "fix": code.map(|c| c.hint()),
            "at": a.ended_at.unwrap_or(a.started_at),
        })
    });
    let server_counts = if reachable {
        api.as_ref()
            .and_then(|a| a.get("/v1/activity?limit=1", "status").ok())
            .map(|v| v["counts"].clone())
    } else {
        None
    };
    let outbox = store.outbox_counts()?;
    let value = json!({
        "home": {
            "mode": mode.as_str(),
            "server": server_url,
            "reachable": reachable,
            "pama_home": pama_core::paths::pama_home(),
        },
        "models": { "server": models, "device": device_model },
        "pipeline": {
            "device": counts,
            "server": server_counts,
            "latest_error": latest_json,
        },
        "sync": { "pending": outbox.pending, "sent": outbox.sent, "failed": outbox.dead },
    });

    ctx.print(&value, || {
        let mut out = String::from("pamA status\n\nHome\n");
        out.push_str(&format!(
            "  data        {}\n",
            if remote_mode {
                "on a server (remote mode)"
            } else {
                "on this machine (local mode)"
            }
        ));
        out.push_str(&format!(
            "  server      {}\n",
            match (&server_url, reachable) {
                (Some(u), true) => format!("{u} (up)"),
                (Some(u), false) => format!("{u} (not reachable)"),
                (None, _) if remote_mode => "not logged in → `pama login --server <url>`".into(),
                (None, _) => "local server not running → `pama server start`".into(),
            }
        ));

        out.push_str("\nModels\n");
        match models.as_object() {
            Some(m) if !m.is_empty() => {
                for r in ROLES {
                    if let Some(x) = m.get(r) {
                        out.push_str(&format!(
                            "  {:<11} {} {} ({}, {})\n",
                            r,
                            x["provider"].as_str().unwrap_or("-"),
                            x["model"].as_str().unwrap_or("-"),
                            if x["local"].as_bool() == Some(true) {
                                "local"
                            } else {
                                "cloud"
                            },
                            match x["origin"].as_str() {
                                Some("env") => "from env",
                                Some("saved") | Some("settings") => "saved",
                                Some(o) => o,
                                None => "-",
                            }
                        ));
                    }
                }
            }
            _ => out.push_str("  server      unknown (server not reachable)\n"),
        }
        if let Some(d) = &device_model {
            out.push_str(&format!(
                "  {:<11} {} {} (drafts on this machine)\n",
                "draft",
                d["provider"].as_str().unwrap_or("-"),
                d["model"].as_str().unwrap_or("-")
            ));
        }

        out.push_str("\nPipeline\n");
        out.push_str(&format!(
            "  running     {}   queued {}\n",
            counts.running, counts.detected
        ));
        let review = server_counts
            .as_ref()
            .and_then(|c| c["awaiting_review"].as_i64());
        out.push_str(&format!(
            "  review      {}\n",
            match review {
                Some(n) => format!("{n} digest(s) awaiting review → `pama review`"),
                None => format!("{} drafted on this machine", counts.ready_for_review),
            }
        ));
        out.push_str(&format!(
            "  done        {} submitted, {} skipped\n",
            counts.submitted, counts.skipped
        ));
        let server_failed = server_counts
            .as_ref()
            .and_then(|c| c["failed"].as_i64())
            .unwrap_or(0);
        out.push_str(&format!(
            "  failed      {}{}\n",
            counts.failed,
            if server_failed > 0 {
                format!(" (server: {server_failed} run(s))")
            } else {
                String::new()
            }
        ));
        if let Some(a) = &latest {
            let code = a.error_code.as_deref().unwrap_or("error");
            out.push_str(&format!(
                "  last error  ✗ {code} ({}, capture {})\n",
                ago(a.ended_at.unwrap_or(a.started_at)),
                short_id(&a.capture_id)
            ));
            if let Some(m) = &a.error_detail {
                out.push_str(&format!("              {m}\n"));
            }
            if let Some(h) = ErrorCode::parse(code).map(|c| c.hint()) {
                out.push_str(&format!("              → {h}\n"));
            }
        }

        out.push_str("\nSync\n");
        out.push_str(&format!(
            "  outbox      {} pending, {} sent, {} failed\n",
            outbox.pending, outbox.sent, outbox.dead
        ));

        let next = if counts.failed > 0 {
            "`pama activity --failed`"
        } else if review.unwrap_or(0) > 0 {
            "`pama review`"
        } else {
            "`pama activity` · `pama doctor` · `pama --help`"
        };
        out.push_str(&format!("\nNext: {next}"));
        out
    });
    Ok(Exit::Ok)
}
