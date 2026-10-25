//! `pama config set|get`. Secrets (keys ending in `.key`) go to the OS keychain, never to disk.

use pama_core::client::{KEY_DECLARED_HOSTS, KEY_STRICT_OFFLINE};
use serde_json::json;

use super::Ctx;
use crate::{ConfigAction, Exit};

const KNOWN: [&str; 12] = [
    "provider.chat.provider",
    "provider.chat.model",
    "provider.chat.base_url",
    "provider.small.model",
    "provider.embed.provider",
    "provider.embed.model",
    "provider.embed.base_url",
    "hotkey.answer_source",
    KEY_STRICT_OFFLINE,
    KEY_DECLARED_HOSTS,
    "hotkey.accelerator",
    "sync.default_target",
];

fn is_secret(key: &str) -> bool {
    key.starts_with("provider.") && key.ends_with(".key")
}

fn validate(key: &str, value: &str) -> Result<(), String> {
    match key {
        "provider.chat.provider" | "provider.embed.provider"
            if !["anthropic", "openai-compatible", "openrouter", "ollama"].contains(&value) =>
        {
            Err("provider must be anthropic, openai-compatible, openrouter or ollama".into())
        }
        "hotkey.answer_source" if !["local", "server", "auto"].contains(&value) => {
            Err("answer_source must be local, server or auto".into())
        }
        k if k == KEY_STRICT_OFFLINE && !["true", "false"].contains(&value) => {
            Err("strict_offline must be true or false".into())
        }
        _ => Ok(()),
    }
}

pub fn run(ctx: &Ctx, action: ConfigAction) -> anyhow::Result<Exit> {
    pama_core::secrets::init_platform_store();
    match action {
        ConfigAction::Set { key, value } => {
            if is_secret(&key) {
                pama_core::secrets::set(&key, &value)?;
                ctx.print(&json!({ "key": key, "stored": "keychain" }), || {
                    format!("{key} saved to the OS keychain")
                });
                return Ok(Exit::Ok);
            }
            if !KNOWN.contains(&key.as_str()) {
                eprintln!("error: unknown key {key}; known keys: {}", KNOWN.join(", "));
                return Ok(Exit::User);
            }
            if let Err(e) = validate(&key, &value) {
                eprintln!("error: {e}");
                return Ok(Exit::User);
            }
            ctx.store.set_setting(&key, &value)?;
            ctx.print(&json!({ "key": key, "value": value }), || {
                format!("{key} = {value}")
            });
        }
        ConfigAction::Get { key } => {
            if is_secret(&key) {
                let set = pama_core::secrets::exists(&key)?;
                ctx.print(&json!({ "key": key, "set": set }), || {
                    format!("{key} is {}", if set { "set (hidden)" } else { "not set" })
                });
                return Ok(Exit::Ok);
            }
            let v = ctx.store.setting(&key)?;
            ctx.print(&json!({ "key": key, "value": v }), || {
                v.clone().unwrap_or_else(|| "(not set)".into())
            });
        }
    }
    Ok(Exit::Ok)
}
