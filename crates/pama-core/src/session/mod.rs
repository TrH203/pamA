//! Agent session parsers (Claude Code, Codex, Cursor, OpenCode) and Layer-1 redaction over their events.

pub mod claude;
pub mod codex;
pub mod cursor;
mod event;
pub mod opencode;
pub mod reader;
mod redact;

pub use event::{
    BranchVisit, Event, EventKind, NormalizedSession, SessionMeta, MAX_EDIT_CHARS, MAX_RESULT_CHARS,
};
pub use redact::redact_session;
