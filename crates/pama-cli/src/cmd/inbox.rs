//! `pama inbox`, `pama reply <ask_id> "<text>"`, `pama log [--link] [--status]`.

use pama_core::client::Api;
use serde_json::{json, Value};

use super::{api_exit, Ctx};
use crate::Exit;

fn with_api(
    ctx: &Ctx,
    f: impl FnOnce(&Api) -> Result<(Value, String), pama_core::client::ApiError>,
) -> anyhow::Result<Exit> {
    let api = match ctx.api() {
        Ok(a) => a,
        Err(e) => return Ok(api_exit(&e)),
    };
    match f(&api) {
        Ok((v, text)) => {
            ctx.print(&v, || text);
            Ok(Exit::Ok)
        }
        Err(e) => Ok(api_exit(&e)),
    }
}

pub fn inbox(ctx: &Ctx) -> anyhow::Result<Exit> {
    with_api(ctx, |api| {
        api.get("/v1/inbox", "inbox").map(|v| {
            let text = v["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|a| {
                    format!(
                        "{}  [{}] {}\n    from {}",
                        a["id"].as_str().unwrap_or("?"),
                        a["link_title"].as_str().unwrap_or("link"),
                        a["question"].as_str().unwrap_or(""),
                        a["asker_email"]
                            .as_str()
                            .filter(|_| a["asker_verified"].as_bool() == Some(true))
                            .unwrap_or("anonymous")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            (
                v,
                if text.is_empty() {
                    "inbox is empty".into()
                } else {
                    format!("{text}\n\nreply: pama reply <id> \"text\"")
                },
            )
        })
    })
}

pub fn reply(ctx: &Ctx, id: &str, text: &str) -> anyhow::Result<Exit> {
    with_api(ctx, |api| {
        api.post(
            &format!("/v1/asks/{id}/reply"),
            "inbox.reply",
            &json!({ "text": text }),
        )
        .map(|v| (v, "reply sent; it appears on the link page".into()))
    })
}

pub fn log(ctx: &Ctx, link: Option<String>, status: Option<String>) -> anyhow::Result<Exit> {
    let mut q = Vec::new();
    if let Some(l) = link {
        q.push(format!("link={l}"));
    }
    if let Some(s) = status {
        q.push(format!("status={s}"));
    }
    let path = if q.is_empty() {
        "/v1/audit".to_string()
    } else {
        format!("/v1/audit?{}", q.join("&"))
    };
    with_api(ctx, |api| {
        api.get(&path, "audit").map(|v| {
            let text = v["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|a| {
                    let cites = a["citations"].as_array().map_or(0, Vec::len);
                    format!(
                        "{}  {:<15} {} cite(s)  {}",
                        a["created_at"]
                            .as_str()
                            .unwrap_or("?")
                            .get(..16)
                            .unwrap_or(""),
                        a["status"].as_str().unwrap_or("?"),
                        cites,
                        a["question"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            (
                v,
                if text.is_empty() {
                    "no questions yet".into()
                } else {
                    text
                },
            )
        })
    })
}
