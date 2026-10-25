//! Model calls for on-device drafting (research R4): Anthropic, any OpenAI-compatible endpoint
//! or Ollama, each returning one JSON object. Every request goes through the egress guard, so
//! strict offline mode and the network log cover drafting too. API keys come from the keychain.

use std::time::Duration;

use serde_json::{json, Value};

use super::DraftError;
use crate::client::policy_from;
use crate::net::GuardedClient;
use crate::store::Store;

const TIMEOUT: Duration = Duration::from_secs(120);
const OLLAMA_DEFAULT: &str = "http://127.0.0.1:11434";
const ANTHROPIC_DEFAULT: &str = "https://api.anthropic.com";
const OPENROUTER_DEFAULT: &str = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL: &str = "qwen3:14b";
const PURPOSE: &str = "draft.model";

pub trait DraftModel {
    /// Model id recorded in the digest's provenance.
    fn id(&self) -> String;
    /// One completion that returns a JSON object matching `schema`.
    fn complete(&self, system: &str, user: &str, schema: &Value) -> Result<Value, DraftError>;
}

/// Drafting model settings on the device (the same keys the local server is started with).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelConfig {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
}

impl ModelConfig {
    pub fn from_store(store: &Store) -> Self {
        let get = |k: &str| store.setting(k).ok().flatten().filter(|v| !v.is_empty());
        let provider = get("provider.chat.provider").unwrap_or_else(|| "ollama".into());
        // The digest runs on the "small" model on the server; same choice here.
        let model = get("provider.small.model")
            .or_else(|| get("provider.chat.model"))
            .unwrap_or_else(|| DEFAULT_MODEL.into());
        Self {
            provider,
            model,
            base_url: get("provider.chat.base_url"),
        }
    }

    /// True when the model runs on this machine or the LAN.
    pub fn is_local(&self) -> bool {
        if self.provider == "ollama" {
            return true;
        }
        if self.provider == "anthropic" || self.provider == "openrouter" {
            return false;
        }
        let host = self
            .base_url
            .as_deref()
            .and_then(|u| crate::net::host_port(u).ok())
            .map(|(h, _)| h)
            .unwrap_or_default();
        host == "localhost"
            || host.starts_with("127.")
            || host.starts_with("10.")
            || host.starts_with("192.168.")
            || host.ends_with(".local")
            || host.ends_with(".lan")
    }
}

pub struct HttpModel<'s> {
    pub config: ModelConfig,
    key: Option<String>,
    client: GuardedClient<'s>,
}

impl<'s> HttpModel<'s> {
    pub fn new(store: &'s Store, component: &'static str) -> Result<Self, DraftError> {
        let config = ModelConfig::from_store(store);
        let key = crate::secrets::get(&format!("provider.{}.key", config.provider))
            .ok()
            .flatten();
        match config.provider.as_str() {
            "anthropic" if key.is_none() => {
                return Err(DraftError::Fatal(
                    "no Anthropic API key: `pama config set provider.anthropic.key -`".into(),
                ))
            }
            "openai-compatible" if config.base_url.is_none() => {
                return Err(DraftError::Fatal(
                    "openai-compatible drafting needs provider.chat.base_url".into(),
                ))
            }
            "openrouter" if key.is_none() => {
                return Err(DraftError::Fatal(
                    "no OpenRouter API key: `pama config set provider.openrouter.key -`".into(),
                ))
            }
            "anthropic" | "openai-compatible" | "openrouter" | "ollama" => {}
            other => {
                return Err(DraftError::Fatal(format!(
                    "unknown drafting provider `{other}` (anthropic, openai-compatible, openrouter, ollama)"
                )))
            }
        }
        Ok(Self {
            config,
            key,
            client: GuardedClient::new(policy_from(store), store, component),
        })
    }

    fn base(&self, default: &str) -> String {
        self.config
            .base_url
            .as_deref()
            .unwrap_or(default)
            .trim_end_matches('/')
            .to_string()
    }

    fn send(&self, req: reqwest::blocking::RequestBuilder) -> Result<Value, DraftError> {
        let resp = req
            .timeout(TIMEOUT)
            .send()
            .map_err(|e| DraftError::Retryable(format!("model unreachable: {e}")))?;
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        match status {
            200..=299 => serde_json::from_str(&text)
                .map_err(|e| DraftError::Fatal(format!("model returned invalid JSON: {e}"))),
            408 | 429 | 500..=599 => Err(DraftError::Retryable(format!("model returned {status}"))),
            _ => Err(DraftError::Fatal(format!(
                "model returned {status}: {}",
                text.chars().take(300).collect::<String>()
            ))),
        }
    }

    fn check(&self, url: &str) -> Result<(), DraftError> {
        self.client
            .check(url, PURPOSE)
            .map_err(|e| DraftError::Retryable(e.to_string()))
    }
}

/// Parse a JSON object out of model text (tolerates code fences and leading prose).
pub fn json_in(text: &str) -> Result<Value, DraftError> {
    let start = text.find('{');
    let end = text.rfind('}');
    match (start, end) {
        (Some(a), Some(b)) if b > a => serde_json::from_str(&text[a..=b])
            .map_err(|e| DraftError::Fatal(format!("model reply is not JSON: {e}"))),
        _ => Err(DraftError::Fatal("model reply has no JSON object".into())),
    }
}

impl DraftModel for HttpModel<'_> {
    fn id(&self) -> String {
        self.config.model.clone()
    }

    fn complete(&self, system: &str, user: &str, schema: &Value) -> Result<Value, DraftError> {
        match self.config.provider.as_str() {
            "anthropic" => {
                let url = format!("{}/v1/messages", self.base(ANTHROPIC_DEFAULT));
                self.check(&url)?;
                // One forced tool call: the tool input is the structured digest.
                let body = json!({
                    "model": self.config.model,
                    "max_tokens": 4096,
                    "temperature": 0,
                    "system": system,
                    "messages": [{ "role": "user", "content": user }],
                    "tools": [{
                        "name": "session_digest",
                        "description": "Record the Session Digest.",
                        "input_schema": schema,
                    }],
                    "tool_choice": { "type": "tool", "name": "session_digest" },
                });
                let v = self.send(
                    self.client
                        .raw()
                        .post(&url)
                        .header("x-api-key", self.key.as_deref().unwrap_or_default())
                        .header("anthropic-version", "2023-06-01")
                        .json(&body),
                )?;
                v["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|c| c["type"] == "tool_use")
                    .map(|c| c["input"].clone())
                    .ok_or_else(|| DraftError::Fatal("model did not return the digest".into()))
            }
            "openai-compatible" | "openrouter" => {
                let default = if self.config.provider == "openrouter" {
                    OPENROUTER_DEFAULT
                } else {
                    ""
                };
                let url = format!("{}/chat/completions", self.base(default));
                self.check(&url)?;
                let body = json!({
                    "model": self.config.model,
                    "temperature": 0,
                    "response_format": { "type": "json_object" },
                    "messages": [
                        { "role": "system", "content": format!("{system}\n\nJSON schema:\n{schema}") },
                        { "role": "user", "content": user },
                    ],
                });
                let mut req = self.client.raw().post(&url).json(&body);
                if let Some(k) = &self.key {
                    req = req.bearer_auth(k);
                }
                let v = self.send(req)?;
                json_in(v["choices"][0]["message"]["content"].as_str().unwrap_or(""))
            }
            _ => {
                let url = format!("{}/api/chat", self.base(OLLAMA_DEFAULT));
                self.check(&url)?;
                let body = json!({
                    "model": self.config.model,
                    "stream": false,
                    "format": schema,
                    "options": { "temperature": 0 },
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": user },
                    ],
                });
                let v = self.send(self.client.raw().post(&url).json(&body))?;
                json_in(v["message"]["content"].as_str().unwrap_or(""))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_json_in_model_text() {
        assert_eq!(
            json_in("```json\n{\"goal\":\"x\"}\n```").unwrap(),
            json!({ "goal": "x" })
        );
        assert!(json_in("no json here").is_err());
    }

    #[test]
    fn config_defaults_and_locality() {
        let s = Store::open_in_memory().unwrap();
        let c = ModelConfig::from_store(&s);
        assert_eq!(c.provider, "ollama");
        assert_eq!(c.model, DEFAULT_MODEL);
        assert!(c.is_local());
        s.set_setting("provider.chat.provider", "openai-compatible")
            .unwrap();
        s.set_setting("provider.chat.model", "big").unwrap();
        s.set_setting("provider.small.model", "small").unwrap();
        s.set_setting("provider.chat.base_url", "https://api.example.com/v1")
            .unwrap();
        let c = ModelConfig::from_store(&s);
        assert_eq!(c.model, "small");
        assert!(!c.is_local());
    }
}
