//! `pama model show|set|switch|check|revert|setup` (specs/003-model-settings/contracts/cli.md).
//! Thin client of the server's `/v1/models/*` endpoints, so CLI and web console always agree.

use std::io::{BufRead, IsTerminal, Write};

use pama_core::client::{Api, ApiError};
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
    let k = super::read_secret("API key")?;
    anyhow::ensure!(!k.is_empty(), "empty key on stdin");
    Ok(k)
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
fn apply(ctx: &Ctx, api: &Api, a: &Apply) -> Result<Exit, ApiError> {
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

/// The device's drafting model (remote mode): where each value comes from.
fn device_row(ctx: &Ctx) -> Value {
    use pama_core::draft::llm::ModelConfig;
    pama_core::secrets::init_platform_store();
    let c = ModelConfig::from_store(&ctx.store);
    let saved = ctx
        .store
        .setting("provider.chat.provider")
        .ok()
        .flatten()
        .is_some();
    let key_set =
        pama_core::secrets::exists(&pama_core::providers::key_name(&c.provider)).unwrap_or(false);
    let base_url = pama_core::providers::resolve(&c.provider, c.base_url.as_deref()).1;
    json!({
        "role": "drafting", "scope": "device", "provider": c.provider, "model": c.model,
        "base_url": base_url, "local": c.is_local(), "key_set": key_set,
        "origin": if saved { "saved" } else { "default" },
    })
}

fn origin_label(o: &str) -> &str {
    match o {
        "env" => "from env",
        "saved" => "saved",
        "default" => "default",
        "device" => "device",
        other => other,
    }
}

/// `/v1/models/effective` (spec 005), or the older settings view on servers without it.
fn effective(api: &Api) -> Result<Value, ApiError> {
    match api.get("/v1/models/effective", "model.show") {
        Err(ApiError::Status { status: 404, .. }) => {
            let v = api.get("/v1/models/settings", "model.show")?;
            let mut roles = serde_json::Map::new();
            for r in ROLES {
                let x = &v["roles"][r];
                roles.insert(
                    r.into(),
                    json!({
                        "provider": x["provider"], "model": x["model"], "base_url": x["baseUrl"],
                        "key_set": x["keySet"], "local": x["local"], "verified": x["verified"],
                        "origin": x["source"], "scope": x["scope"].as_str().unwrap_or("server"),
                    }),
                );
            }
            Ok(json!({ "strict_offline": v["strict_offline"], "roles": roles }))
        }
        other => other,
    }
}

fn show(ctx: &Ctx, api: &Api) -> Result<Exit, ApiError> {
    let mut v = effective(api)?;
    let remote_mode = api.remote_url().is_some();
    if remote_mode {
        v["device"] = device_row(ctx);
    }
    ctx.print(&v, || {
        let mut out = String::new();
        let line = |label: &str, x: &Value| {
            format!(
                "{:<9} {:<18} {:<5} {:<28} {:<9} key {:<8} {:<10} {}\n",
                label,
                x["preset"].as_str().unwrap_or(s(x, "provider")),
                if x["local"].as_bool() == Some(true) {
                    "local"
                } else {
                    "cloud"
                },
                s(x, "model"),
                origin_label(s(x, "origin")),
                if x["key_set"].as_bool() == Some(true) {
                    "set"
                } else {
                    "not set"
                },
                if x["scope"] == "workspace" {
                    "workspace"
                } else if x["verified"].as_bool() == Some(true) {
                    "verified"
                } else {
                    ""
                },
                x["base_url"].as_str().unwrap_or(""),
            )
        };
        if remote_mode {
            out.push_str(&format!("server models ({}):\n", api.base_url()));
        }
        for r in ROLES {
            out.push_str(&line(r, &v["roles"][r]));
        }
        if remote_mode {
            out.push_str("this machine (drafts digests):\n");
            out.push_str(&line("drafting", &v["device"]));
        }
        if v["strict_offline"].as_bool() == Some(true) {
            out.push_str("strict offline: on\n");
        }
        out.trim_end().to_string()
    });
    Ok(Exit::Ok)
}

fn check(ctx: &Ctx, api: &Api, role: Option<String>) -> Result<Exit, ApiError> {
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

fn setup(ctx: &Ctx, api: &Api, preset: Option<String>) -> anyhow::Result<Exit> {
    use pama_core::providers;
    if !std::io::stdin().is_terminal() {
        eprintln!("error: `pama model setup` needs an interactive terminal; use `pama model set`");
        return Ok(Exit::User);
    }
    let cur = match api.get("/v1/models/settings", "model.show") {
        Ok(v) => v,
        Err(e) => return Ok(api_exit(&e)),
    };
    let presets: Vec<&str> = providers::registry()
        .presets
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    let preset = match preset {
        Some(p) => Some(p),
        None => {
            println!("Presets:");
            for p in &providers::registry().presets {
                println!("  {:<20} {}", p.id, p.label);
            }
            let a = ask("preset (empty = choose each role)", "")?;
            (!a.is_empty()).then_some(a)
        }
    };
    let preset = match preset.as_deref() {
        Some(id) => match providers::preset(id) {
            Some(p) => Some(p),
            None => {
                eprintln!("error: unknown preset {id} ({})", presets.join(", "));
                return Ok(Exit::User);
            }
        },
        None => None,
    };
    let ids = providers::ids().join(", ");
    for role in ROLES {
        let x = &cur["roles"][role];
        println!("\n{role}:");
        let (provider, model) = match preset.and_then(|p| p.roles.get(role)) {
            Some(r) => {
                println!("  {} / {}", r.provider, r.model);
                (r.provider.clone(), r.model.clone())
            }
            None => {
                let provider = ask(&format!("provider ({ids})"), s(x, "provider"))?;
                let suggested =
                    providers::get(&provider).and_then(|p| p.suggested_for(role).first().cloned());
                let default_model = if s(x, "provider") == provider {
                    s(x, "model").to_string()
                } else {
                    suggested.unwrap_or_default()
                };
                (provider, ask("model", &default_model)?)
            }
        };
        let entry = providers::get(&provider);
        if entry.is_some_and(|p| !p.supports(role)) {
            eprintln!("{provider} cannot serve the {role} role; skipped");
            continue;
        }
        let base_url = match entry.map(|p| p.locality) {
            Some(providers::Locality::Cloud) | Some(providers::Locality::Local)
                if preset.is_some() =>
            {
                String::new()
            }
            _ if provider == "anthropic" || provider == "openrouter" => String::new(),
            _ => ask(
                "endpoint (empty = default)",
                entry
                    .and_then(|p| p.default_base_url.as_deref())
                    .unwrap_or(s(x, "baseUrl")),
            )?,
        };
        let key = if entry.is_some_and(|p| p.needs_key) {
            super::read_secret(&format!("{provider} API key (empty = keep current)"))?
        } else {
            String::new()
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

/// `pama model --device …`: the model this machine drafts digests with in remote mode (spec
/// 004). Settings live in the device store, keys in the OS keychain.
fn run_device(ctx: &Ctx, action: ModelAction) -> anyhow::Result<Exit> {
    use pama_core::draft::llm::{DraftModel, HttpModel, ModelConfig};
    pama_core::secrets::init_platform_store();
    let show = |ctx: &Ctx| {
        let v = device_row(ctx);
        ctx.print(&v, || {
            format!(
                "drafting  {:<18} {:<5} {:<24} {:<8} key {:<8} {}",
                s(&v, "provider"),
                if v["local"] == true { "local" } else { "cloud" },
                s(&v, "model"),
                origin_label(s(&v, "origin")),
                if v["key_set"] == true {
                    "set"
                } else {
                    "not set"
                },
                v["base_url"].as_str().unwrap_or("")
            )
        });
    };
    match action {
        ModelAction::Show => {
            show(ctx);
            Ok(Exit::Ok)
        }
        ModelAction::Set(ModelSet {
            role,
            provider,
            model,
            base_url,
            key_stdin,
            yes,
            ..
        }) => {
            if role == "embed" {
                eprintln!("error: the device only drafts digests; embeddings run on the server");
                return Ok(Exit::User);
            }
            let candidate = ModelConfig {
                provider: provider.clone(),
                model: model.clone(),
                base_url: base_url.clone(),
            };
            if !candidate.is_local()
                && !yes
                && !confirm(&format!(
                    "Drafting sends redacted session text to {provider}. Continue?"
                ))
            {
                eprintln!("error: confirm with --yes: drafting with {provider} sends redacted session text to it");
                return Ok(Exit::User);
            }
            let st = &ctx.store;
            st.set_setting("provider.chat.provider", &provider)?;
            st.set_setting(
                if role == "small" {
                    "provider.small.model"
                } else {
                    "provider.chat.model"
                },
                &model,
            )?;
            if role == "chat" {
                // One drafting model: drop a stale small-model override.
                st.delete_setting("provider.small.model")?;
            }
            match &base_url {
                Some(u) => st.set_setting("provider.chat.base_url", u)?,
                None => st.delete_setting("provider.chat.base_url")?,
            }
            if key_stdin {
                pama_core::secrets::set(&pama_core::providers::key_name(&provider), &read_key()?)?;
            }
            show(ctx);
            Ok(Exit::Ok)
        }
        ModelAction::Check { .. } => {
            let started = std::time::Instant::now();
            let result = HttpModel::new(&ctx.store, "cli").and_then(|m| {
                m.complete(
                    "Reply with the JSON object {\"ok\": true}.",
                    "ping",
                    &json!({ "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"] }),
                )
            });
            let ms = started.elapsed().as_millis() as u64;
            let ok = result.is_ok();
            let detail = match &result {
                Ok(_) => "drafting model answers with JSON".to_string(),
                Err(e) => e.to_string(),
            };
            ctx.print(
                &json!({ "ok": ok, "detail": detail, "latencyMs": ms }),
                || {
                    format!(
                        "drafting: {}\n  {} {detail}\n  {ms} ms",
                        if ok { "ok" } else { "problem" },
                        mark(ok)
                    )
                },
            );
            Ok(if ok { Exit::Ok } else { Exit::Config })
        }
        _ => {
            eprintln!("error: with --device use show, set or check");
            Ok(Exit::User)
        }
    }
}

pub fn run(ctx: &Ctx, device: bool, action: ModelAction) -> anyhow::Result<Exit> {
    if device {
        return run_device(ctx, action);
    }
    let api = match ctx.api() {
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
        ModelAction::Setup { preset } => return setup(ctx, &api, preset),
    };
    Ok(r.unwrap_or_else(|e| api_exit(&e)))
}
