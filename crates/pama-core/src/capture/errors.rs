//! Pipeline error taxonomy (spec 006, plan 4.2): every capture failure or skip carries a stable
//! code, a readable message, a fix hint and a retry policy. Server errors arrive as
//! `{"error": {"code", "message"}}` and keep the server's code.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ProviderUnreachable,
    ProviderAuth,
    RateLimited,
    ModelTimeout,
    ProviderError,
    InvalidModelOutput,
    TranscriptMissing,
    TranscriptTooLarge,
    EmptySession,
    ProjectNotEnabled,
    SyncNotEnabled,
    NotLoggedIn,
    ServerDown,
    SyncRejected,
    Internal,
}

/// What the worker does after an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// Try again later on the retry schedule.
    Retry,
    /// A configuration problem: stop and wait for the user (`pama activity retry`).
    WaitForUser,
    /// Retrying the same input will not help.
    GiveUp,
    /// Not an error: the capture is skipped with this reason.
    Skip,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 15] = [
        Self::ProviderUnreachable,
        Self::ProviderAuth,
        Self::RateLimited,
        Self::ModelTimeout,
        Self::ProviderError,
        Self::InvalidModelOutput,
        Self::TranscriptMissing,
        Self::TranscriptTooLarge,
        Self::EmptySession,
        Self::ProjectNotEnabled,
        Self::SyncNotEnabled,
        Self::NotLoggedIn,
        Self::ServerDown,
        Self::SyncRejected,
        Self::Internal,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProviderUnreachable => "provider_unreachable",
            Self::ProviderAuth => "provider_auth",
            Self::RateLimited => "rate_limited",
            Self::ModelTimeout => "model_timeout",
            Self::ProviderError => "provider_error",
            Self::InvalidModelOutput => "invalid_model_output",
            Self::TranscriptMissing => "transcript_missing",
            Self::TranscriptTooLarge => "transcript_too_large",
            Self::EmptySession => "empty_session",
            Self::ProjectNotEnabled => "project_not_enabled",
            Self::SyncNotEnabled => "sync_not_enabled",
            Self::NotLoggedIn => "not_logged_in",
            Self::ServerDown => "server_down",
            Self::SyncRejected => "sync_rejected",
            Self::Internal => "internal",
        }
    }

    /// Parse a stored or server code; unknown codes are `None`.
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == s)
    }

    pub fn policy(self) -> Policy {
        match self {
            Self::ProviderUnreachable
            | Self::RateLimited
            | Self::ModelTimeout
            | Self::ProviderError
            | Self::TranscriptMissing
            | Self::ServerDown
            | Self::Internal => Policy::Retry,
            Self::ProviderAuth | Self::NotLoggedIn => Policy::WaitForUser,
            Self::InvalidModelOutput | Self::TranscriptTooLarge | Self::SyncRejected => {
                Policy::GiveUp
            }
            Self::EmptySession | Self::ProjectNotEnabled | Self::SyncNotEnabled => Policy::Skip,
        }
    }

    /// Configuration errors the owner must fix (desktop notifies about these).
    pub fn is_config(self) -> bool {
        matches!(
            self,
            Self::ProviderAuth | Self::NotLoggedIn | Self::ProjectNotEnabled
        )
    }

    /// One line on how to fix it, with a command where there is one.
    pub fn hint(self) -> &'static str {
        match self {
            Self::ProviderUnreachable => {
                "Start the model server (e.g. `ollama serve`) or pick another provider with `pama model set <role>`; check with `pama model check`."
            }
            Self::ProviderAuth => {
                "Save a valid API key: `pama model set <role> --provider <p> --model <m> --key-stdin`, then `pama activity retry --all-failed`."
            }
            Self::RateLimited => "The provider is rate limiting; pamA retries on its own.",
            Self::ModelTimeout => {
                "The model was too slow; try a smaller model (`pama model set small`) or check the provider."
            }
            Self::ProviderError => "The provider returned an error; see the detail and `pama model check`.",
            Self::InvalidModelOutput => {
                "The model did not return a valid digest; try a stronger drafting model, then `pama activity retry <id>`."
            }
            Self::TranscriptMissing => "The transcript file is gone or unreadable; pamA retries in case it is still being written.",
            Self::TranscriptTooLarge => "The transcript exceeds the size limit and is not digested.",
            Self::EmptySession => "Nothing to digest: the session had no real conversation.",
            Self::ProjectNotEnabled => "Capture is off for this project: run `pama init` in it.",
            Self::SyncNotEnabled => {
                "Sync is off for this project: `pama sync enable --project <key>`."
            }
            Self::NotLoggedIn => "Connect this machine to the server: `pama login --server <url>`.",
            Self::ServerDown => "The server is not reachable: `pama server start` (local) or check the network.",
            Self::SyncRejected => "The server rejected this digest; see the detail.",
            Self::Internal => "Unexpected error; see `pama logs` and report it if it persists.",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A coded failure with what is known about the model call that failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CodedError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The server's run id for this request, when it sent one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

impl CodedError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            role: None,
            provider: None,
            model: None,
            run_id: None,
        }
    }
}

impl std::fmt::Display for CodedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// `Embedding model (ollama bge-m3) …` → role, provider, model from the server's message.
fn model_from_message(msg: &str) -> (Option<String>, Option<String>, Option<String>) {
    let role = [
        ("Chat model", "chat"),
        ("Small model", "small"),
        ("Embedding model", "embed"),
    ]
    .into_iter()
    .find(|(label, _)| msg.starts_with(label))
    .map(|(_, r)| r.to_string());
    let Some(role) = role else {
        return (None, None, None);
    };
    let inner = msg
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(inside, _)| inside.trim());
    let (provider, model) = match inner.and_then(|s| s.split_once(' ')) {
        Some((p, m)) => (Some(p.to_string()), Some(m.to_string())),
        None => (inner.map(str::to_string), None),
    };
    (Some(role), provider, model)
}

/// Map a server error reply (status + body) to a coded error. Bodies follow
/// contracts/http-api.md: `{"error": {"code": "...", "message": "..."}}`.
pub fn from_server(status: u16, body: &str) -> CodedError {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let code = v["error"]["code"].as_str().unwrap_or_default();
    let message = v["error"]["message"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| {
            let b = body.trim();
            if b.is_empty() {
                format!("server returned {status}")
            } else {
                format!(
                    "server returned {status}: {}",
                    b.chars().take(300).collect::<String>()
                )
            }
        });
    let mapped = ErrorCode::parse(code).unwrap_or(match (status, code) {
        (_, "unauthorized") | (401, _) => ErrorCode::NotLoggedIn,
        (_, "sync_disabled") => ErrorCode::SyncNotEnabled,
        (_, "timeout") => ErrorCode::ModelTimeout,
        (429, _) => ErrorCode::RateLimited,
        (502..=504, _) => ErrorCode::ServerDown,
        (500..=599, _) => ErrorCode::Internal,
        _ => ErrorCode::SyncRejected,
    });
    let (role, provider, model) = model_from_message(&message);
    CodedError {
        code: mapped,
        message,
        role,
        provider,
        model,
        run_id: None,
    }
}

/// Map an on-device drafting failure (remote mode, `draft::DraftError`) to a code.
pub fn from_draft(retryable: bool, message: &str) -> CodedError {
    let m = message.to_ascii_lowercase();
    let code = if retryable {
        if m.contains("429") {
            ErrorCode::RateLimited
        } else if m.contains("408") || m.contains("timed out") || m.contains("timeout") {
            ErrorCode::ModelTimeout
        } else if m.contains("unreachable") || m.contains("blocked") || m.contains("connect") {
            ErrorCode::ProviderUnreachable
        } else {
            ErrorCode::ProviderError
        }
    } else if m.contains("api key")
        || m.contains(" 401")
        || m.contains(" 403")
        || m.contains("needs provider")
        || m.contains("unknown drafting provider")
    {
        ErrorCode::ProviderAuth
    } else if m.contains("json")
        || m.contains("schema")
        || m.contains("invalid")
        || m.contains("did not return")
    {
        ErrorCode::InvalidModelOutput
    } else {
        ErrorCode::ProviderError
    };
    let mut e = CodedError::new(code, message);
    e.role = Some("draft".into());
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_device_drafting_errors() {
        assert_eq!(
            from_draft(true, "model unreachable: connection refused").code,
            ErrorCode::ProviderUnreachable
        );
        assert_eq!(
            from_draft(true, "model returned 429").code,
            ErrorCode::RateLimited
        );
        assert_eq!(
            from_draft(true, "model unreachable: operation timed out").code,
            ErrorCode::ModelTimeout
        );
        assert_eq!(
            from_draft(
                false,
                "no OpenRouter API key: `pama config set provider.openrouter.key -`"
            )
            .code,
            ErrorCode::ProviderAuth
        );
        assert_eq!(
            from_draft(false, "model returned 401: unauthorized").code,
            ErrorCode::ProviderAuth
        );
        assert_eq!(
            from_draft(false, "model reply does not match the schema: x").code,
            ErrorCode::InvalidModelOutput
        );
    }

    #[test]
    fn codes_round_trip() {
        for c in ErrorCode::ALL {
            assert_eq!(ErrorCode::parse(c.as_str()), Some(c));
            assert!(!c.hint().is_empty());
        }
        assert_eq!(ErrorCode::parse("nope"), None);
    }

    #[test]
    fn parses_server_error_bodies() {
        let e = from_server(
            502,
            r#"{"error":{"code":"provider_unreachable","message":"Embedding model (ollama bge-m3) is unreachable. Start Ollama."}}"#,
        );
        assert_eq!(e.code, ErrorCode::ProviderUnreachable);
        assert_eq!(e.role.as_deref(), Some("embed"));
        assert_eq!(e.provider.as_deref(), Some("ollama"));
        assert_eq!(e.model.as_deref(), Some("bge-m3"));
        assert!(e.message.starts_with("Embedding model"));

        let auth = from_server(
            502,
            r#"{"error":{"code":"provider_auth","message":"Small model (openrouter qwen/qwen3-8b) rejected the API key (HTTP 401)."}}"#,
        );
        assert_eq!(auth.code, ErrorCode::ProviderAuth);
        assert_eq!(auth.code.policy(), Policy::WaitForUser);
        assert!(auth.code.is_config());
        assert_eq!(auth.model.as_deref(), Some("qwen/qwen3-8b"));

        assert_eq!(
            from_server(504, r#"{"error":{"code":"model_timeout","message":"x"}}"#).code,
            ErrorCode::ModelTimeout
        );
        assert_eq!(
            from_server(
                500,
                r#"{"error":{"code":"internal","message":"internal error"}}"#
            )
            .code,
            ErrorCode::Internal
        );
        assert_eq!(
            from_server(
                422,
                r#"{"error":{"code":"invalid_request","message":"bad"}}"#
            )
            .code,
            ErrorCode::SyncRejected
        );
        assert_eq!(
            from_server(401, r#"{"error":{"code":"unauthorized","message":"x"}}"#).code,
            ErrorCode::NotLoggedIn
        );
        assert_eq!(
            from_server(409, r#"{"error":{"code":"sync_disabled","message":"x"}}"#).code,
            ErrorCode::SyncNotEnabled
        );
        let html = from_server(502, "<html>bad gateway</html>");
        assert_eq!(html.code, ErrorCode::ServerDown);
        assert!(html.message.contains("502"));
        assert_eq!(html.role, None);
    }

    #[test]
    fn policies() {
        assert_eq!(ErrorCode::ProviderUnreachable.policy(), Policy::Retry);
        assert_eq!(ErrorCode::NotLoggedIn.policy(), Policy::WaitForUser);
        assert_eq!(ErrorCode::TranscriptTooLarge.policy(), Policy::GiveUp);
        assert_eq!(ErrorCode::EmptySession.policy(), Policy::Skip);
        assert!(!ErrorCode::RateLimited.is_config());
    }
}
