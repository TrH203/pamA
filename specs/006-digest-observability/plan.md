# Implementation Plan: Digest Pipeline Observability

**Branch**: `006-digest-observability` | **Spec**: [spec.md](spec.md) | **Source**: docs/plans/v0.2-overhaul.md §4

## Summary

Add attempt history and an error taxonomy on the device, run records on the server, and CLI /
desktop surfaces that read them. The HTTP digest call stays synchronous (the async `202 {run_id}`
variant in plan §4.1 is deferred); runs already give the stage timeline and resume.

## Technical Context

- Device: Rust, `crates/pama-core` (SQLite store, capture worker), `crates/pama-cli` (clap),
  `crates/pama-desktop/src-tauri` (background loop, tauri notification plugin).
- Server: TypeScript, Hono, drizzle schema + raw SQL migration `0011_digest_runs.sql`
  (works on PGlite and Postgres), vitest.
- No new crates or npm packages; output is plain text (colours come later from another slice).

## Design

### Device

- `capture/errors.rs`: `ErrorCode` (snake_case, stable), `Policy`, `hint()`, `is_config()`,
  `from_server(status, body)` (parses `{error:{code,message}}`, extracts role/provider/model from
  messages like `Embedding model (ollama bge-m3) …`), `from_draft` for on-device drafting errors,
  `NotifyGate` for the desktop de-duplication.
- `store`: table `capture_attempt`; columns `error_code`, `first_failed_at` etc. on
  `captured_session` added with `ensure_column`; `retry_delay_ms(failures, since_first)`
  implements 1m/5m/30m/2h/6h within 24h; `fail_capture` applies the code's policy;
  `skip_capture` stores the reason code; `retry_capture` / `retry_all_failed` re-enqueue without
  touching attempts.
- `capture/worker.rs`: each `process` opens an attempt, records stages (`parsed`, `redacted`,
  `submitted`), runs the empty-session guard before redaction/model calls, and finishes the
  attempt with outcome and code. `SinkError` boxes a `CodedError`.

### Server

- `digest_runs` with `kind` (transcript | draft), `stage`, `status`, coded error,
  role/provider/model, `digest_id`, `resume` (jsonb draft kept after drafting), `attempts`.
- `routes/activity.ts`: `tracked()` wraps digest/draft handlers; list/show/retry; SSE with an
  in-process `runBus` and a heartbeat every 15s (shortened in tests).
- Response header `pama-run-id` lets the device link an attempt to its server run.

### CLI

- `cmd/status.rs`, `cmd/activity.rs` (activity + logs), doctor "digest pipeline" check.
- `pama logs` takes a positional `device|server` instead of `--server`, because the global
  `--server <url>` flag already exists.

### Desktop

- `background.rs`: `drain_due` picks local server or remote mode (`RemoteSink` + `HttpModel`);
  review/inbox counts use `Api::resolve`; config errors since the last tick are notified through
  `NotifyGate` (1 hour per code), also emitted as `pipeline://error`.

## Constitution Check

- I (raw transcripts never leave the machine / never stored by server): `digest_runs.resume`
  holds only the cleaned draft, never events.
- V (tests for safety-critical code): error parsing, retry policy, empty-session guard, run
  recording and SSE are covered by tests.
