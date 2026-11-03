# Feature Specification: Digest Pipeline Observability

**Feature Branch**: `006-digest-observability`

**Created**: 2026-10-31

**Status**: Implemented (backend, CLI, desktop); web UI is spec 009

**Input**: docs/plans/v0.2-overhaul.md section 4. At any time the owner can answer three
questions: where is the session that just ended, did it fail, and why / how to fix it.

## User Scenarios & Testing

### User Story 1 - See where every captured session is (P1)

After an agent session ends, the owner runs `pama status` (or bare `pama`) and `pama activity`
and sees each capture with its stage timeline (`parsed → redacted → submitted → ✓ stored`), the
number of attempts and the next retry time.

**Acceptance**: a capture that was retried three times shows three attempts with their own
stages, durations and errors; re-enqueueing (`pama activity retry`) keeps the earlier attempts.

### User Story 2 - Understand and fix a failure (P1)

A failed digest shows a stable error code (plan 4.2), the role/provider/model involved and a
one-line fix with a command, e.g. `provider_unreachable` on `embed (ollama bge-m3)` →
"Start the model server (`ollama serve`) …".

**Acceptance**: a server reply `{"error":{"code":"provider_auth","message":"Small model
(openrouter qwen/qwen3-8b) rejected the API key"}}` is stored on the attempt as
`provider_auth`, role `small`, provider `openrouter`, model `qwen/qwen3-8b`; `pama status`
prints it under "last error" with the fix.

### User Story 3 - Retries that make sense (P1)

Transient errors retry on 1m, 5m, 30m, 2h, then every 6h, up to 24h after the first failure.
Configuration errors (`provider_auth`, `not_logged_in`) stop and wait for the owner;
empty sessions and projects without capture are skipped with a reason code and never reach a
model.

### User Story 4 - Server-side runs and live events (P2)

Every `/v1/transcripts/digest` and `/v1/sync/drafts` request is a `digest_runs` row moving
`received → drafted → classified → embedded → stored`, ending `succeeded` or `failed` with the
coded error. If embedding fails after drafting, the cleaned draft is kept and
`POST /v1/activity/:id/retry` (or the device re-sending the same session) resumes from embed
without new model calls for drafting. The console (spec 009) reads `GET /v1/activity` and the
SSE stream `GET /v1/events`.

### User Story 5 - Desktop tells the owner when the pipeline is blocked (P2)

The desktop app shows an OS notification when an attempt fails with a configuration error, at
most once per error code per hour.

### Edge Cases

- Server unreachable while draining: every due capture records a failed attempt with
  `server_down` and backs off.
- Server error body that is not JSON (proxy HTML): mapped by HTTP status (`502..504` →
  `server_down`, `5xx` → `internal`, `401` → `not_logged_in`, `429` → `rate_limited`).
- Old device database: new columns are added on open (`ensure_column`).
- No drafting model on the device (remote mode, missing key): CLI and desktop record a failed
  attempt on every due capture with the coded error, so config errors are notified.

## Requirements

### Functional Requirements

- **FR-001**: The device store MUST keep one `capture_attempt` row per attempt (capture id,
  attempt number, stage, outcome, started/ended, duration, error code/detail, role, provider,
  model, digest id, server run id). Re-enqueue MUST NOT delete attempts.
- **FR-002**: A capture whose draft is accepted by the server MUST record the server
  `digest_id` and become `submitted`; remote-mode drafts become `submitted` when the outbox
  delivers them.
- **FR-003**: A `skipped` capture MUST store a reason code (`project_not_enabled`,
  `sync_not_enabled`, `empty_session`).
- **FR-004**: Server errors `{error:{code,message}}` MUST be parsed into the taxonomy
  `provider_unreachable, provider_auth, rate_limited, model_timeout, provider_error,
  invalid_model_output, transcript_missing, transcript_too_large, empty_session,
  project_not_enabled, sync_not_enabled, not_logged_in, server_down, sync_rejected, internal`.
  Each code has a hint and a policy (retry, wait for user, give up, skip).
- **FR-005**: Retry schedule 1m, 5m, 30m, 2h, then every 6h, no retry starting more than 24h
  after the first failure. A drain waits for retries up to 5 minutes away and then exits; a
  later retry runs when something starts a drain after it is due: an agent hook, the desktop
  app (every minute), or, on a CLI-only install, any owner command (`pama`, `status`,
  `activity`, `scan`, `review`, library commands, ...), which starts a background drain when a
  retry of an already-failed capture is due and no drain holds the lock (at most once a minute).
  A capture left `redacting`/`digesting` by a drain that died is recovered by the next drain
  (attempt ends `internal`, "interrupted") once its attempt is older than the 10-minute lock
  window; a running drain refreshes its lock before each capture.
- **FR-006**: A session MUST be skipped with `empty_session` before any model call unless it
  has a user message, an agent response (assistant text or at least one tool call), and at
  least 40 characters of conversation, where a tool call counts with its command, path or
  input text and tool results do not count. "fix it" followed by edits is real work; a
  greeting with a one-line reply, or tool output without a user message, is not.
- **FR-007**: The server MUST record a `digest_runs` row (migration 0011) for every digest and
  draft ingest, with stage updates and the coded error, role, provider, model.
- **FR-008**: When a later stage fails after drafting, the run MUST keep the drafted output so a
  retry resumes from embed.
- **FR-009**: Routes: `GET /v1/activity` (filter `status`, `since`; cursor pagination; counts),
  `GET /v1/activity/:id`, `POST /v1/activity/:id/retry` (resumable runs only; the run is
  claimed atomically, so a concurrent second retry gets 409 `conflict`, and a run that a newer
  run of the same session replaced gets 409 `superseded`; storing a kept draft is idempotent),
  `GET /v1/events` (SSE `run.updated`, `review.count`, `inbox.count`, `heartbeat`).
- **FR-010**: CLI: `pama status` (also bare `pama`), `pama activity [--failed] [--follow]
  [--limit]`, `pama activity show <id>`, `pama activity retry <id>|--all-failed`,
  `pama logs [device|server] [-n N] [--follow]`; every command supports `--json`.
- **FR-011**: Device capture state stays on the device (decision): it is not posted to the
  server. `pama status`, `pama activity` and `pama doctor` ("digest pipeline" check) read it from
  the device store; server runs are fetched by id when the attempt has a run id.
- **FR-012**: The desktop app MUST notify about configuration errors (`provider_auth`,
  `not_logged_in`, `project_not_enabled`; skips excluded) at most once per code per hour, and its
  background drain MUST follow remote mode (draft on the device, queue for the server).

### Key Entities

- **capture_attempt** (device SQLite) — one try at digesting a captured session.
- **digest_runs** (server Postgres/PGlite) — one digest request processed by the server.

## Success Criteria

- **SC-001**: For any failed capture, `pama status` shows its code and a fix command without
  reading logs.
- **SC-002**: A provider outage of up to 24h loses no captures: they retry and succeed later.
- **SC-003**: No model call is made for empty sessions (verified by tests with a counting sink).
- **SC-004**: An embedding outage after drafting costs no extra drafting call on retry.
