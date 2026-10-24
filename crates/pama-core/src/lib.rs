//! pamA device core.
//!
//! Everything here runs on the owner's machine. Raw transcripts are read in place and never
//! leave the device; only Layer-1-redacted events and approved digests are handed on.
pub mod capture;
pub mod client;
pub mod digest;
pub mod draft;
pub mod net;
pub mod paths;
pub mod project;
pub mod redact;
pub mod remote;
pub mod secrets;
pub mod session;
pub mod sidecar;
pub mod store;
pub mod sync;
