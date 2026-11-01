//! Shared model provider registry (spec 005): `packages/types/providers.json`, compiled in. The
//! server reads the same file, so provider ids, default endpoints and the "runs on this machine"
//! rule (`is_local`) are identical on both sides.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::policy_from;
use crate::net::GuardedClient;
use crate::store::Store;

/// The registry file as shipped (also read by the parity test on the TypeScript side).
pub const REGISTRY_JSON: &str = include_str!("../../../packages/types/providers.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Locality {
    Local,
    Cloud,
    /// Decided by the endpoint's host (LAN or loopback = local).
    ByHost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Suggested {
    #[serde(default)]
    pub chat: Vec<String>,
    #[serde(default)]
    pub small: Vec<String>,
    #[serde(default)]
    pub embed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub label: String,
    /// Wire protocol: `ollama`, `anthropic`, `openrouter` or `openai-compatible`.
    pub protocol: String,
    pub locality: Locality,
    pub default_base_url: Option<String>,
    pub needs_key: bool,
    pub roles: Vec<String>,
    pub suggested: Suggested,
}

impl Provider {
    pub fn supports(&self, role: &str) -> bool {
        self.roles.iter().any(|r| r == role)
    }

    pub fn suggested_for(&self, role: &str) -> &[String] {
        match role {
            "embed" => &self.suggested.embed,
            "small" => &self.suggested.small,
            _ => &self.suggested.chat,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetRole {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub label: String,
    pub roles: std::collections::BTreeMap<String, PresetRole>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalHosts {
    pub exact: Vec<String>,
    pub prefixes: Vec<String>,
    pub suffixes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registry {
    pub version: u32,
    pub local_hosts: LocalHosts,
    pub providers: Vec<Provider>,
    pub presets: Vec<Preset>,
}

pub fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| serde_json::from_str(REGISTRY_JSON).expect("providers.json is valid"))
}

pub fn get(id: &str) -> Option<&'static Provider> {
    registry().providers.iter().find(|p| p.id == id)
}

/// Every provider id, in registry order (CLI value lists, validation).
pub fn ids() -> Vec<&'static str> {
    registry().providers.iter().map(|p| p.id.as_str()).collect()
}

pub fn preset(id: &str) -> Option<&'static Preset> {
    registry().presets.iter().find(|p| p.id == id)
}

/// Is this host on this machine or the LAN?
pub fn is_local_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    let l = &registry().local_hosts;
    l.exact.iter().any(|e| *e == h)
        || l.prefixes.iter().any(|p| h.starts_with(p.as_str()))
        || l.suffixes.iter().any(|s| h.ends_with(s.as_str()))
}

fn host_of(url: &str) -> String {
    crate::net::host_port(url)
        .map(|(h, _)| h)
        .unwrap_or_default()
}

/// True when the model runs on this machine or the LAN. Unknown providers are decided by host.
pub fn is_local(provider: &str, base_url: Option<&str>) -> bool {
    let p = get(provider);
    match p.map(|p| p.locality).unwrap_or(Locality::ByHost) {
        Locality::Local => true,
        Locality::Cloud => false,
        Locality::ByHost => {
            let url = base_url.or(p.and_then(|p| p.default_base_url.as_deref()));
            url.is_some_and(|u| is_local_host(&host_of(u)))
        }
    }
}

/// The protocol and endpoint a (provider, base_url) pair talks to. A preset id such as
/// `lmstudio` becomes `openai-compatible` with its default endpoint; legacy ids map to themselves.
pub fn resolve(provider: &str, base_url: Option<&str>) -> (String, Option<String>) {
    match get(provider) {
        Some(p) => (
            p.protocol.clone(),
            base_url
                .map(str::to_string)
                .or_else(|| p.default_base_url.clone()),
        ),
        None => (provider.to_string(), base_url.map(str::to_string)),
    }
}

/// The registry entry a stored (provider, base_url) pair corresponds to: an exact id first, then
/// a preset whose default endpoint matches (`openai-compatible` + LM Studio's URL → `lmstudio`).
pub fn preset_for(provider: &str, base_url: Option<&str>) -> Option<&'static Provider> {
    let norm = |u: &str| u.trim_end_matches('/').to_ascii_lowercase();
    if provider == "openai-compatible" {
        if let Some(u) = base_url {
            if let Some(p) = registry().providers.iter().find(|p| {
                p.id != "openai-compatible"
                    && p.protocol == "openai-compatible"
                    && p.default_base_url.as_deref().map(norm) == Some(norm(u))
            }) {
                return Some(p);
            }
        }
    }
    get(provider)
}

/// The keychain entry holding a provider's API key.
pub fn key_name(provider: &str) -> String {
    format!("provider.{provider}.key")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyTest {
    pub ok: bool,
    pub detail: String,
    pub latency_ms: u64,
}

/// Check that a provider answers with the given key: a model listing, which costs nothing.
/// Goes through the egress guard (strict offline mode and the network log apply).
pub fn test_key(
    store: &Store,
    provider: &str,
    base_url: Option<&str>,
    key: Option<&str>,
) -> KeyTest {
    let (protocol, base) = resolve(provider, base_url);
    let Some(base) = base.map(|b| b.trim_end_matches('/').to_string()) else {
        return KeyTest {
            ok: false,
            detail: format!("{provider} needs an endpoint (base URL)"),
            latency_ms: 0,
        };
    };
    let url = match protocol.as_str() {
        "ollama" => format!("{base}/api/tags"),
        "anthropic" => format!("{base}/v1/models"),
        _ => format!("{base}/models"),
    };
    let client = GuardedClient::new(policy_from(store), store, "cli");
    if let Err(e) = client.check(&url, "keys.test") {
        return KeyTest {
            ok: false,
            detail: e.to_string(),
            latency_ms: 0,
        };
    }
    let mut req = client.raw().get(&url).timeout(Duration::from_secs(15));
    if let Some(k) = key {
        req = match protocol.as_str() {
            "anthropic" => req
                .header("x-api-key", k)
                .header("anthropic-version", "2023-06-01"),
            _ => req.bearer_auth(k),
        };
    }
    let started = std::time::Instant::now();
    let res = req.send();
    let latency_ms = started.elapsed().as_millis() as u64;
    match res {
        Ok(r) => {
            let status = r.status().as_u16();
            let (ok, detail) = match status {
                200..=299 => (true, format!("{provider} accepted the key")),
                401 | 403 => (false, format!("{provider} rejected the key ({status})")),
                s => (false, format!("{provider} returned {s}")),
            };
            KeyTest {
                ok,
                detail,
                latency_ms,
            }
        }
        Err(e) => KeyTest {
            ok: false,
            detail: format!("{provider} unreachable at {base}: {e}"),
            latency_ms,
        },
    }
}

/// The registry as JSON (for `--json` output).
pub fn registry_value() -> Value {
    serde_json::from_str(REGISTRY_JSON).expect("providers.json is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_loads_and_keeps_legacy_ids() {
        let ids = ids();
        for legacy in ["ollama", "openai-compatible", "anthropic", "openrouter"] {
            assert!(ids.contains(&legacy), "{legacy}");
        }
        for new in ["lmstudio", "vllm", "openai", "deepinfra"] {
            assert!(ids.contains(&new), "{new}");
        }
        for p in &registry().presets {
            for r in p.roles.values() {
                assert!(
                    get(&r.provider).is_some(),
                    "preset {} uses {}",
                    p.id,
                    r.provider
                );
            }
        }
        assert!(!get("anthropic").unwrap().supports("embed"));
    }

    #[test]
    fn locality_matches_the_old_rules() {
        assert!(is_local("ollama", Some("https://ollama.example.com")));
        assert!(!is_local("anthropic", None));
        assert!(!is_local("openrouter", None));
        assert!(!is_local("openai-compatible", None));
        for h in [
            "http://localhost:1/v1",
            "http://127.0.0.1:8000/v1",
            "http://10.1.2.3/v1",
            "http://192.168.1.2/v1",
            "http://172.16.0.1/v1",
            "http://172.31.9.9/v1",
            "http://gpu.local/v1",
            "http://box.lan/v1",
        ] {
            assert!(is_local("openai-compatible", Some(h)), "{h}");
        }
        for h in [
            "http://172.32.0.1/v1",
            "https://api.example.com/v1",
            "http://11.0.0.1/v1",
        ] {
            assert!(!is_local("openai-compatible", Some(h)), "{h}");
        }
        assert!(is_local("lmstudio", None));
        assert!(is_local("vllm", None));
        assert!(!is_local("vllm", Some("https://vllm.example.com/v1")));
        assert!(!is_local("openai", None));
    }

    /// The same cases the server's test reads (registry parity, spec 005).
    #[test]
    fn shared_fixture_parity() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../packages/types/fixtures/provider-locality.json"
        ))
        .unwrap();
        let ids: Vec<&str> = f["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(super::ids(), ids);
        for c in f["is_local"].as_array().unwrap() {
            let (p, u) = (c["provider"].as_str().unwrap(), c["base_url"].as_str());
            assert_eq!(is_local(p, u), c["local"].as_bool().unwrap(), "{p} {u:?}");
        }
        for c in f["preset_for"].as_array().unwrap() {
            let (p, u) = (c["provider"].as_str().unwrap(), c["base_url"].as_str());
            assert_eq!(
                preset_for(p, u).map(|x| x.id.as_str()),
                c["preset"].as_str(),
                "{p} {u:?}"
            );
        }
    }

    #[test]
    fn presets_resolve_to_stored_protocols() {
        assert_eq!(
            resolve("lmstudio", None),
            (
                "openai-compatible".into(),
                Some("http://127.0.0.1:1234/v1".into())
            )
        );
        assert_eq!(resolve("ollama", None).0, "ollama");
        assert_eq!(
            resolve("custom-thing", Some("http://x")),
            ("custom-thing".into(), Some("http://x".into()))
        );
        assert_eq!(
            preset_for(
                "openai-compatible",
                Some("https://api.deepinfra.com/v1/openai/")
            )
            .map(|p| p.id.as_str()),
            Some("deepinfra")
        );
        assert_eq!(
            preset_for("openai-compatible", Some("https://x.example/v1")).map(|p| p.id.as_str()),
            Some("openai-compatible")
        );
    }
}
