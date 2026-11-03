//! `pama keys list|set|test|remove` (spec 005): provider API keys on this machine. Keys live in
//! the OS keychain only, are read from stdin, and are never printed.

use pama_core::providers;
use pama_core::secrets;
use pama_core::store::Store;
use serde_json::{json, Value};

use super::Ctx;
use crate::{Exit, KeysAction};

fn tested_key(provider: &str) -> String {
    format!("keys.tested:{provider}")
}

/// Where secrets are kept on this machine.
pub fn storage() -> &'static str {
    if std::env::var_os("PAMA_SECRETS_FILE").is_some() {
        "file (PAMA_SECRETS_FILE, tests only)"
    } else if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else if cfg!(windows) {
        "Windows Credential Manager"
    } else {
        "OS keychain"
    }
}

/// One row per registry provider: whether a key is stored and the last test.
pub fn list_value(store: &Store) -> Value {
    let drafting = store.setting("provider.chat.provider").ok().flatten();
    let rows: Vec<Value> = providers::registry()
        .providers
        .iter()
        .map(|p| {
            let stored = secrets::exists(&providers::key_name(&p.id)).unwrap_or(false);
            let tested: Value = store
                .setting(&tested_key(&p.id))
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null);
            json!({
                "provider": p.id,
                "label": p.label,
                "needs_key": p.needs_key,
                "stored": stored,
                "where": if stored { Some(storage()) } else { None },
                "used_by_drafting": drafting.as_deref() == Some(p.id.as_str()),
                "last_test": tested,
            })
        })
        .collect();
    json!({ "storage": storage(), "keys": rows })
}

fn known(provider: &str) -> bool {
    providers::get(provider).is_some()
}

pub fn run(ctx: &Ctx, action: KeysAction) -> anyhow::Result<Exit> {
    secrets::init_platform_store();
    match action {
        KeysAction::List => {
            let v = list_value(&ctx.store);
            ctx.print(&v, || {
                use crate::ui::{self, Mark};
                let mut rows = Vec::new();
                for r in v["keys"].as_array().into_iter().flatten() {
                    let stored = r["stored"] == true;
                    if !stored && r["needs_key"] != true {
                        continue;
                    }
                    let test = match &r["last_test"] {
                        Value::Null => ui::dim("not tested"),
                        t => format!(
                            "{} {}",
                            if t["ok"] == true {
                                Mark::Ok.label("ok")
                            } else {
                                Mark::Fail.label("failed")
                            },
                            ui::dim(t["at"].as_str().unwrap_or(""))
                        ),
                    };
                    rows.push(vec![
                        r["provider"].as_str().unwrap_or("").to_string(),
                        if stored {
                            Mark::Ok.label("stored")
                        } else {
                            Mark::Info.label("no key")
                        },
                        if stored {
                            r["where"].as_str().unwrap_or("").to_string()
                        } else {
                            ui::dim("-")
                        },
                        test,
                        if r["used_by_drafting"] == true {
                            "drafting model".to_string()
                        } else {
                            String::new()
                        },
                    ]);
                }
                format!(
                    "{}\n\n{} {}",
                    ui::table(&["PROVIDER", "KEY", "WHERE", "LAST TEST", "USED BY"], rows),
                    ui::dim("Set one with"),
                    ui::cmd("pama keys set <provider>")
                ) + &ui::dim(" (reads stdin)")
            });
            Ok(Exit::Ok)
        }
        KeysAction::Set { provider } => {
            if !known(&provider) {
                crate::fail!("usage", "unknown provider {provider}");
                return Ok(Exit::User);
            }
            let k = super::read_secret(&format!("{provider} API key"))?;
            if k.is_empty() {
                crate::fail!("usage", "empty key on stdin");
                return Ok(Exit::User);
            }
            secrets::set(&providers::key_name(&provider), &k)?;
            let _ = ctx.store.delete_setting(&tested_key(&provider));
            ctx.print(
                &json!({ "provider": provider, "stored": true, "where": storage() }),
                || {
                    format!(
                        "{provider} key stored in {}; check it with `pama keys test {provider}`",
                        storage()
                    )
                },
            );
            Ok(Exit::Ok)
        }
        KeysAction::Remove { provider } => {
            let name = providers::key_name(&provider);
            let had = secrets::exists(&name).unwrap_or(false);
            secrets::delete(&name)?;
            let _ = ctx.store.delete_setting(&tested_key(&provider));
            ctx.print(&json!({ "provider": provider, "removed": had }), || {
                if had {
                    format!("{provider} key removed")
                } else {
                    format!("no {provider} key was stored")
                }
            });
            Ok(Exit::Ok)
        }
        KeysAction::Test { provider, base_url } => {
            let key = secrets::get(&providers::key_name(&provider))?;
            let needs = providers::get(&provider).is_some_and(|p| p.needs_key);
            if needs && key.is_none() {
                crate::fail!(
                    "not_found",
                    "no {provider} key stored; `pama keys set {provider}`"
                );
                return Ok(Exit::Config);
            }
            // The drafting model's endpoint when it uses this provider (custom base URLs).
            let base_url = base_url.or_else(|| {
                (ctx.store
                    .setting("provider.chat.provider")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some(provider.as_str()))
                .then(|| ctx.store.setting("provider.chat.base_url").ok().flatten())
                .flatten()
            });
            let spin = crate::ui::spinner(ctx.json, &format!("testing the {provider} key…"));
            let t = providers::test_key(&ctx.store, &provider, base_url.as_deref(), key.as_deref());
            spin.finish();
            let at = pama_core::capture::worker::rfc3339(std::time::SystemTime::now());
            let record = json!({ "at": at, "ok": t.ok, "detail": t.detail });
            ctx.store
                .set_setting(&tested_key(&provider), &record.to_string())?;
            ctx.print(
                &json!({ "provider": provider, "ok": t.ok, "detail": t.detail, "latencyMs": t.latency_ms }),
                || {
                    format!(
                        "{} {}  {}",
                        crate::ui::Mark::from_ok(t.ok).sym(),
                        t.detail,
                        crate::ui::dim(&format!("({} ms)", t.latency_ms))
                    )
                },
            );
            Ok(if t.ok { Exit::Ok } else { Exit::Config })
        }
    }
}
