//! `pama link create|list|revoke` (contracts/cli.md).

use pama_core::client::LocalApi;
use serde_json::{json, Value};

use super::{api_exit, Ctx};
use crate::{Exit, LinkAction, LinkCreate};

/// `bundle:<id>`, `project:<id>`, `session:<id>`, or a bare id (bundle).
fn source_ref(s: &str) -> Value {
    match s.split_once(':') {
        Some((t @ ("bundle" | "project" | "session"), id)) => json!({ "type": t, "id": id }),
        _ => json!({ "type": "bundle", "id": s }),
    }
}

fn create(api: &LocalApi, a: &LinkCreate) -> Result<(Value, String), pama_core::client::ApiError> {
    let mut sources: Vec<Value> = a.sources.iter().map(|s| source_ref(s)).collect();
    let mut picked = String::new();
    if let Some(q) = &a.suggest {
        let r = api.post("/v1/suggest", "link.suggest", &json!({ "query": q }))?;
        for s in r["sources"].as_array().into_iter().flatten() {
            if s["preselected"].as_bool() == Some(true) {
                sources.push(s["ref"].clone());
                picked.push_str(&format!(
                    "  ✓ {} ({})\n",
                    s["title"].as_str().unwrap_or("?"),
                    s["project"].as_str().unwrap_or("?")
                ));
            } else if !s["flagged_labels"].as_array().is_none_or(|l| l.is_empty()) {
                picked.push_str(&format!(
                    "  ⚠ {} not included (labels: {})\n",
                    s["title"].as_str().unwrap_or("?"),
                    s["flagged_labels"]
                        .as_array()
                        .map(|l| l
                            .iter()
                            .filter_map(|x| x.as_str())
                            .collect::<Vec<_>>()
                            .join(", "))
                        .unwrap_or_default()
                ));
            }
        }
    }
    let (deny_labels, deny_topics): (Vec<&String>, Vec<&String>) = a
        .deny
        .iter()
        .partition(|d| ["business_sensitive", "infra", "customer"].contains(&d.as_str()));
    let mut body = json!({
        "sources": sources,
        "expires": a.expires,
        "detail": a.detail,
        "deny_labels": deny_labels,
        "deny_topics": deny_topics,
        "access_mode": a.access,
    });
    if let Some(i) = &a.instruction {
        body["instruction"] = json!(i);
    }
    if let Some(p) = &a.pin {
        body["pin"] = json!(p);
    }
    if !a.allow.is_empty() {
        body["allowlist"] = json!(a.allow);
    }
    let v = api.post("/v1/links", "link.create", &body)?;
    let mut text = picked;
    text.push_str(&format!("\n{}\n", v["url"].as_str().unwrap_or("?")));
    if let Some(pin) = v["pin"].as_str() {
        text.push_str(&format!("PIN: {pin}\n"));
    }
    Ok((v, text))
}

pub fn run(ctx: &Ctx, action: LinkAction) -> anyhow::Result<Exit> {
    let api = match LocalApi::connect(&ctx.store, "cli") {
        Ok(a) => a,
        Err(e) => return Ok(api_exit(&e)),
    };
    let r = match &action {
        LinkAction::Create(a) => {
            if a.sources.is_empty() && a.suggest.is_none() {
                eprintln!("error: give --source <ref> or --suggest \"<question>\"");
                return Ok(Exit::User);
            }
            create(&api, a)
        }
        LinkAction::List => api.get("/v1/links", "link.list").map(|v| {
            let text = v["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|l| {
                    format!(
                        "{:<12} {:<8} {:<10} {:>3} asks  {}",
                        l["slug"].as_str().unwrap_or("?"),
                        l["status"].as_str().unwrap_or("?"),
                        l["access_mode"].as_str().unwrap_or("?"),
                        l["asks"],
                        l["title"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            (
                v,
                if text.is_empty() {
                    "no links yet".into()
                } else {
                    text
                },
            )
        }),
        LinkAction::Revoke { slug } => api
            .post(
                &format!("/v1/links/{slug}/revoke"),
                "link.revoke",
                &json!({}),
            )
            .map(|v| (v, format!("revoked {slug}"))),
    };
    match r {
        Ok((v, text)) => {
            ctx.print(&v, || text);
            Ok(Exit::Ok)
        }
        Err(e) => Ok(api_exit(&e)),
    }
}
