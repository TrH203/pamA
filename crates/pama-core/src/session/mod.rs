//! Agent session adapters (Claude Code, Codex) and Layer-1 redaction over their events.

pub mod claude;
pub mod codex;
mod event;
pub mod reader;
mod redact;

pub use event::{
    Event, EventKind, NormalizedSession, SessionMeta, MAX_EDIT_CHARS, MAX_RESULT_CHARS,
};
pub use redact::redact_session;
