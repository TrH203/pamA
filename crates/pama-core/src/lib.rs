//! pamA device core.
//!
//! Everything here runs on the owner's machine. Raw transcripts are read in place and never
//! leave the device; only Layer-1-redacted events and approved digests are handed on.
pub mod digest;
pub mod redact;
