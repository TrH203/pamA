//! `pama model show|set|switch|check|revert|setup` (specs/003-model-settings/contracts/cli.md).
//! Thin client of the server's `/v1/models/*` endpoints, so CLI and web console always agree.

use std::io::{BufRead, IsTerminal, Read, Write};

use pama_core::client::{ApiError, LocalApi};
use serde_json::{json, Value};

use super::{api_exit, Ctx};
use crate::{Exit, ModelAction, ModelSet, SwitchTarget};

const ROLES: [&str; 3] = ["chat", "small", "embed"];

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

fn mark(ok: bool) -> &'static str {
    if ok {
        "✓"
    } else {
        "✗"
    }
}

fn print_check(c: &Value) {
    for i in c["items"].as_array().into_iter().flatten() {
        let fix = i["fix"]
            .as_str()
            .map(|f| format!(" — {f}"))
            .unwrap_or_default();
        println!(
            "  {} {}{fix}",
            mark(i["ok"].as_bool() == Some(true)),
            s(i, "detail")
        );
    }
    if let Some(ms) = c["latencyMs"].as_i64() {
        println!("  {ms} ms");
    }
}

/// The error body of a non-2xx response, if it is JSON.
fn body_of(e: &ApiError) -> Option<Value> {
    match e {
        ApiError::Status { body, .. } => serde_json::from_str(body).ok(),
        _ => None,
    }
}

fn read_key() -> anyhow::Result<String> {
    let mut k = String::new();
    std::io::stdin().read_to_string(&mut k)?;
    Ok(k.trim().to_string())
}

fn ask(prompt: &str, default: &str) -> anyhow::Result<String> {
    if default.is_empty() {
        print!("{prompt}: ");
    } else {
        print!("{prompt} [{default}]: ");
    }
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    let t = line.trim();
    Ok(if t.is_empty() {
        default.into()
    } else {
        t.into()
    })
}

fn confirm(question: &str) -> bool {
    if !std::io::stdin().is_terminal() {
        return false;
    }
    ask(&format!("{question} (y/N)"), "")
        .map(|a| a.eq_ignore_ascii_case("y"))
        .unwrap_or(false)
}

struct Apply {
    role: String,
    provider: String,
    model: String,
    base_url: Option<String>,
    key: Option<String>,
    yes: bool,
    force: bool,
}

/// PUT the settings, handling the confirmation and unverified flows. Returns the saved view.
fn apply(ctx: &Ctx, api: &LocalApi, a: &Apply) -> Result<Exit, ApiError> {
    let mut confirm_list: Vec<&str> = Vec::new();
    if a.force {
        confirm_list.push("unverified");
    }
    for _ in 0..3 {
        let mut body = json!({ "provider": a.provider, "model": a.model, "confirm": confirm_list });
        if let Some(u) = &a.base_url {
            body["baseUrl"] = json!(u);
        }
        if let Some(k) = &a.key {
            body["apiKey"] = json!(k);
        }
        match api.put(
            &format!("/v1/models/settings/{}", a.role),
            "model.apply",
            &body,
        ) {
            Ok(v) => {
                ctx.print(&v, || {
                    let mut out = format!(
                        "{}: {} {} ({}){}",
                        a.role,
                        s(&v, "provider"),
                        s(&v, "model"),
                        if v["local"].as_bool() == Some(true) {
                            "local"
                        } else {
                            "cloud"
                        },
                        if v["verified"].as_bool() == Some(true) {
                            ", verified"
                        } else {
                            ", unverified"
                        }
                    );
                    if let Some(n) = v["reindexed"].as_i64() {
                        out.push_str(&format!("\nre-indexed {n} items"));
                    }
                    out
                });
                if !ctx.json {
                    print_check(&v["check"]);
                }
                return Ok(Exit::Ok);
            }
            Err(e @ ApiError::Status { status: 409, .. }) => {
                let b = body_of(&e).unwrap_or(Value::Null);
                let required: Vec<String> = b["required"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect();
                if required.is_empty() {
                    return Err(e);
                }
                eprintln!(
                    "{}",
                    b["error"]["message"]
                        .as_str()
                        .unwrap_or("confirmation required")
                );
                if !(a.yes || confirm("Continue?")) {
                    eprintln!("not changed (use --yes to confirm)");
                    return Ok(Exit::User);
                }
                for r in required {
                    match r.as_str() {
                        "data_leaves" => confirm_list.push("data_leaves"),
                        "reindex" => confirm_list.push("reindex"),
                        _ => {}
                    }
                }
            }
            Err(e @ ApiError::Status { status: 422, .. }) => {
                let b = body_of(&e).unwrap_or(Value::Null);
                eprintln!(
                    "error: {}",
                    b["error"]["message"].as_str().unwrap_or("rejected")
                );
                if b["check"].is_object() && !ctx.json {
                    print_check(&b["check"]);
                }
                if b["error"]["code"] == "check_failed" {
                    eprintln!("not changed (use --force to save anyway)");
                }
                return Ok(Exit::Config);
            }
            Err(e) => return Err(e),
        }
    }
    Ok(Exit::User)
}

fn show(ctx: &Ctx, api: &LocalApi) -> Result<Exit, ApiError> {
    let v = api.get("/v1/models/settings", "model.show")?;
    ctx.print(&v, || {
        let mut out = String::new();
        for r in ROLES {
            let x = &v["roles"][r];
            out.push_str(&format!(
                "{:<6} {:<18} {:<5} {:<24} {:<10} key {:<8} {}\n",
                r,
                s(x, "provider"),
                if x["local"].as_bool() == Some(true) {
                    "local"
                } else {
                    "cloud"
                },
                s(x, "model"),
                if x["source"] == "env" {
                    "default"
                } else if x["verified"].as_bool() == Some(true) {
                    "verified"
                } else {
                    "unverified"
                },
                if x["keySet"].as_bool() == Some(true) {
                    "set"
                } else {
                    "not set"
                },
                x["baseUrl"].as_str().unwrap_or(""),
            ));
        }
        if v["strict_offline"].as_bool() == Some(true) {
            out.push_str("strict offline: on\n");
        }
        out.trim_end().to_string()
    });
    Ok(Exit::Ok)
}

fn check(ctx: &Ctx, api: &LocalApi, role: Option<String>) -> Result<Exit, ApiError> {
    let roles: Vec<&str> = match &role {
        Some(r) => vec![r.as_str()],
        None => ROLES.to_vec(),
    };
    let mut all_ok = true;
    let mut results = serde_json::Map::new();
    for r in roles {
        let c = api.post("/v1/models/check", "model.check", &json!({ "role": r }))?;
        all_ok &= c["ok"].as_bool() == Some(true);
        if !ctx.json {
            println!(
                "{r}: {}",
                if c["ok"].as_bool() == Some(true) {
                    "ok"
                } else {
                    "problem"
                }
            );
            print_check(&c);
        }
        results.insert(r.to_string(), c);
    }
    if ctx.json {
        ctx.print(&Value::Object(results), String::new);
    }
    Ok(if all_ok { Exit::Ok } else { Exit::Config })
}

fn setup(ctx: &Ctx, api: &LocalApi) -> anyhow::Result<Exit> {
    if !std::io::stdin().is_terminal() {
        eprintln!("error: `pama model setup` needs an interactive terminal; use `pama model set`");
        return Ok(Exit::User);
    }
    let cur = match api.get("/v1/models/settings", "model.show") {
        Ok(v) => v,
        Err(e) => return Ok(api_exit(&e)),
    };
    for role in ["chat", "embed"] {
        let x = &cur["roles"][role];
        println!("\n{role}:");
        let provider = ask(
            "provider (ollama, openai-compatible, anthropic)",
            s(x, "provider"),
        )?;
        let model = ask("model", s(x, "model"))?;
        let base_url = if provider == "anthropic" {
            String::new()
        } else {
            ask("endpoint (empty = default)", s(x, "baseUrl"))?
        };
        let key = if provider == "ollama" {
            String::new()
        } else {
            ask("API key (empty = keep current)", "")?
        };
        if !confirm(&format!("Save {role}: {provider} / {model}?")) {
            continue;
        }
        let a = Apply {
            role: role.into(),
            provider,
            model,
            base_url: (!base_url.is_empty()).then_some(base_url),
            key: (!key.is_empty()).then_some(key),
            yes: false,
            force: false,
        };
        if let Err(e) = apply(ctx, api, &a) {
            return Ok(api_exit(&e));
        }
    }
    Ok(Exit::Ok)
}

pub fn run(ctx: &Ctx, action: ModelAction) -> anyhow::Result<Exit> {
    let api = match LocalApi::connect(&ctx.store, "cli") {
        Ok(a) => a,
        Err(e) => return Ok(api_exit(&e)),
    };
    let r = match action {
        ModelAction::Show => show(ctx, &api),
        ModelAction::Check { role } => check(ctx, &api, role),
        ModelAction::Revert { role } => api
            .post(
                &format!("/v1/models/settings/{role}/revert"),
                "model.revert",
                &json!({}),
            )
            .map(|v| {
                ctx.print(&v, || {
                    format!("{role}: back to {} {}", s(&v, "provider"), s(&v, "model"))
                });
                Exit::Ok
            }),
        ModelAction::Set(ModelSet {
            role,
            provider,
            model,
            base_url,
            key_stdin,
            yes,
            force,
        }) => {
            let key = if key_stdin { Some(read_key()?) } else { None };
            apply(
                ctx,
                &api,
                &Apply {
                    role,
                    provider,
                    model,
                    base_url,
                    key,
                    yes,
                    force,
                },
            )
        }
        ModelAction::Switch {
            role,
            target,
            provider,
            model,
            base_url,
            key_stdin,
            yes,
            force,
        } => {
            let cur = match api.get("/v1/models/settings", "model.show") {
                Ok(v) => v,
                Err(e) => return Ok(api_exit(&e)),
            };
            let current_model = s(&cur["roles"][role.as_str()], "model").to_string();
            let (provider, model) = match target {
                SwitchTarget::Local => ("ollama".to_string(), model.unwrap_or(current_model)),
                SwitchTarget::Cloud => {
                    let Some(m) = model else {
                        eprintln!("error: --model is required when switching to cloud");
                        return Ok(Exit::User);
                    };
                    let default = if role == "embed" {
                        "openai-compatible"
                    } else {
                        "anthropic"
                    };
                    (provider.unwrap_or_else(|| default.into()), m)
                }
            };
            let key = if key_stdin { Some(read_key()?) } else { None };
            apply(
                ctx,
                &api,
                &Apply {
                    role,
                    provider,
                    model,
                    base_url,
                    key,
                    yes,
                    force,
                },
            )
        }
        ModelAction::Setup => return setup(ctx, &api),
    };
    Ok(r.unwrap_or_else(|e| api_exit(&e)))
}
