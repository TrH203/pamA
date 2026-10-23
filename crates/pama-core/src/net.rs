//! Egress guard for the device (research R13): every outbound request from Rust is checked
//! against the declared hosts in strict offline mode and appended to the device network log.

use std::time::Duration;

use crate::store::Store;

#[derive(Debug, Clone, Default)]
pub struct Policy {
    pub strict: bool,
    /// Hostnames, optionally with `:port`.
    pub declared_hosts: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum NetError {
    #[error("strict offline mode: {0} is not a declared host")]
    Blocked(String),
    #[error("invalid url {0}")]
    Url(String),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),
}

const LOOPBACK: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];

impl Policy {
    pub fn allows(&self, host: &str, port: Option<u16>) -> bool {
        if !self.strict {
            return true;
        }
        let h = host.to_ascii_lowercase();
        if LOOPBACK.contains(&h.as_str()) {
            return true;
        }
        self.declared_hosts.iter().any(|d| {
            let d = d.to_ascii_lowercase();
            match d.split_once(':') {
                Some((dh, dp)) => dh == h && port.map(|p| p.to_string()).as_deref() == Some(dp),
                None => d == h,
            }
        })
    }
}

fn host_port(url: &str) -> Result<(String, Option<u16>), NetError> {
    let rest = url
        .split_once("://")
        .map(|(_, r)| r)
        .ok_or_else(|| NetError::Url(url.into()))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    if let Some(v6) = authority.strip_prefix('[') {
        let (h, tail) = v6
            .split_once(']')
            .ok_or_else(|| NetError::Url(url.into()))?;
        let port = tail.strip_prefix(':').and_then(|p| p.parse().ok());
        return Ok((format!("[{h}]"), port));
    }
    match authority.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => Ok((h.into(), p.parse().ok())),
        _ => Ok((authority.into(), None)),
    }
}

/// HTTP client that applies the policy and logs every request.
pub struct GuardedClient<'s> {
    policy: Policy,
    store: &'s Store,
    component: &'static str,
    http: reqwest::blocking::Client,
}

impl<'s> GuardedClient<'s> {
    pub fn new(policy: Policy, store: &'s Store, component: &'static str) -> Self {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client");
        Self {
            policy,
            store,
            component,
            http,
        }
    }

    /// Check and log; returns an error if the host is blocked.
    pub fn check(&self, url: &str, purpose: &str) -> Result<(), NetError> {
        let (host, port) = host_port(url)?;
        let allowed = self.policy.allows(&host, port);
        self.store
            .log_network(self.component, &host, purpose, allowed)?;
        if allowed {
            Ok(())
        } else {
            Err(NetError::Blocked(host))
        }
    }

    pub fn post_json(
        &self,
        url: &str,
        purpose: &str,
        bearer: Option<&str>,
        body: &serde_json::Value,
    ) -> Result<reqwest::blocking::Response, NetError> {
        self.check(url, purpose)?;
        let mut req = self.http.post(url).json(body);
        if let Some(t) = bearer {
            req = req.bearer_auth(t);
        }
        Ok(req.send()?)
    }

    /// The underlying HTTP client, for requests already allowed by [`Self::check`].
    pub fn raw(&self) -> &reqwest::blocking::Client {
        &self.http
    }

    /// POST after [`Self::check`] already allowed and logged this URL.
    pub fn post_json_prechecked(
        &self,
        url: &str,
        bearer: Option<&str>,
        body: &serde_json::Value,
    ) -> Result<reqwest::blocking::Response, NetError> {
        let mut req = self.http.post(url).json(body);
        if let Some(t) = bearer {
            req = req.bearer_auth(t);
        }
        Ok(req.send()?)
    }

    pub fn get(
        &self,
        url: &str,
        purpose: &str,
        bearer: Option<&str>,
    ) -> Result<reqwest::blocking::Response, NetError> {
        self.check(url, purpose)?;
        let mut req = self.http.get(url);
        if let Some(t) = bearer {
            req = req.bearer_auth(t);
        }
        Ok(req.send()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts() {
        assert_eq!(
            host_port("http://127.0.0.1:7465/v1/x").unwrap(),
            ("127.0.0.1".into(), Some(7465))
        );
        assert_eq!(
            host_port("https://user:pw@pama.acme.vn/a?b").unwrap(),
            ("pama.acme.vn".into(), None)
        );
        assert_eq!(
            host_port("http://[::1]:80/").unwrap(),
            ("[::1]".into(), Some(80))
        );
    }

    #[test]
    fn strict_policy() {
        let p = Policy {
            strict: true,
            declared_hosts: vec!["ollama.lan:11434".into(), "pama.acme.vn".into()],
        };
        assert!(p.allows("localhost", Some(1)));
        assert!(p.allows("ollama.lan", Some(11434)));
        assert!(!p.allows("ollama.lan", Some(80)));
        assert!(p.allows("pama.acme.vn", None));
        assert!(!p.allows("api.anthropic.com", None));
        assert!(Policy::default().allows("anything", None));
    }

    #[test]
    fn blocked_requests_are_logged_and_not_sent() {
        let store = Store::open_in_memory().unwrap();
        let c = GuardedClient::new(
            Policy {
                strict: true,
                declared_hosts: vec![],
            },
            &store,
            "cli",
        );
        let err = c
            .check("https://evil.example.net/x", "sync.digest")
            .unwrap_err();
        assert!(matches!(err, NetError::Blocked(h) if h == "evil.example.net"));
        let log = store.network_log(10).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].host, "evil.example.net");
        assert!(!log[0].allowed);
    }
}
