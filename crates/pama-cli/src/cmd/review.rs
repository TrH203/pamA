//! `pama review`: list draft digests; approve, discard or edit (in `$EDITOR`) one.

use std::process::Command;

use serde_json::{json, Value};

use super::{api_exit, Ctx};
use crate::Exit;

fn edit_in_editor(content: &Value) -> anyhow::Result<Option<Value>> {
    let path = std::env::temp_dir().join(format!("pama-digest-{}.json", ulid::Ulid::generate()));
    std::fs::write(&path, serde_json::to_string_pretty(content)? + "\n")?;
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| {
            if cfg!(windows) {
                "notepad".into()
            } else {
                "vi".into()
            }
        });
    let status = if cfg!(windows) {
        Command::new("cmd")
            .args(["/C", &format!("{editor} \"{}\"", path.display())])
            .status()?
    } else {
        Command::new("sh")
            .args([
                "-c",
                &format!("{editor} \"$1\"",),
                "sh",
                &path.to_string_lossy(),
            ])
            .status()?
    };
    let text = std::fs::read_to_string(&path)?;
    let _ = std::fs::remove_file(&path);
    if !status.success() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&text)?))
}

pub fn run(
    ctx: &Ctx,
    approve: Option<String>,
    discard: Option<String>,
    edit: Option<String>,
) -> anyhow::Result<Exit> {
    let api = match ctx.api() {
        Ok(a) => a,
        Err(e) => return Ok(api_exit(&e)),
    };
    let result = if let Some(id) = approve {
        api.post(&format!("/v1/digests/{id}/approve"), "review", &json!({}))
            .map(|v| {
                (
                    v.clone(),
                    format!("approved {}", v["digest_id"].as_str().unwrap_or(&id)),
                )
            })
    } else if let Some(id) = discard {
        api.post(&format!("/v1/digests/{id}/discard"), "review", &json!({}))
            .map(|v| (v, format!("discarded {id}")))
    } else if let Some(id) = edit {
        let d = match api.get(&format!("/v1/digests/{id}"), "review") {
            Ok(d) => d,
            Err(e) => return Ok(api_exit(&e)),
        };
        let Some(content) = edit_in_editor(&d["content"])? else {
            eprintln!("editor exited with an error; nothing changed");
            return Ok(Exit::User);
        };
        api.post(
            &format!("/v1/digests/{id}/approve"),
            "review",
            &json!({ "content": content }),
        )
        .map(|v| {
            let msg = format!("approved edited digest as version {}", v["version"]);
            (v, msg)
        })
    } else {
        api.get("/v1/review", "review").map(|v| {
            let items = v["items"].as_array().cloned().unwrap_or_default();
            let text = if items.is_empty() {
                "no drafts waiting for review".to_string()
            } else {
                items
                    .iter()
                    .map(|d| {
                        let decisions = d["content"]["decisions"].as_array().map_or(0, Vec::len);
                        format!(
                            "{}  {} / {}{}{}\n    goal: {}\n    {} decision(s), {} secret(s) and {} PII item(s) removed",
                            d["id"].as_str().unwrap_or("?"),
                            d["project"].as_str().unwrap_or("?"),
                            d["bundle"].as_str().unwrap_or("?"),
                            super::bundle_fmt::branch_hint(&d["branches"]),
                            d["device"]
                                .as_str()
                                .map(|n| format!("  (from {n})"))
                                .unwrap_or_default(),
                            d["content"]["goal"].as_str().unwrap_or(""),
                            decisions,
                            d["content"]["redactions"]["secret"],
                            d["content"]["redactions"]["pii"],
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
                    + "\n\napprove: pama review --approve <id> · edit: pama review --edit <id>"
            };
            (v, text)
        })
    };
    match result {
        Ok((v, text)) => {
            // Remote mode: a decision made here updates the device copy right away (FR-025).
            if api.remote_url().is_some() {
                let _ = pama_core::remote::pull_changes(&ctx.store, &api, true);
            }
            ctx.print(&v, || text);
            Ok(Exit::Ok)
        }
        Err(e) => Ok(api_exit(&e)),
    }
}
