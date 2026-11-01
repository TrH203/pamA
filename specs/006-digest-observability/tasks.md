# Tasks: Digest Pipeline Observability

**Input**: `/specs/006-digest-observability/` (spec.md, plan.md)

## Phase 1: Server runs (US4)

- [x] T001 Migration `apps/server/migrations/0011_digest_runs.sql` + drizzle `src/db/schema/runs.ts`
- [x] T002 `src/services/runs.ts`: start/stage/succeed/fail, list with cursor + since, counts, run bus
- [x] T003 Record runs in `/v1/transcripts/digest` and `/v1/sync/drafts` with stages drafted → classified → embedded → stored
- [x] T004 Keep the drafted output when embed fails; resume from embed on retry or device resubmission (`src/pipeline/complete.ts`)
- [x] T005 Routes `GET /v1/activity`, `GET /v1/activity/:id`, `POST /v1/activity/:id/retry`, `GET /v1/events` (SSE + heartbeat)
- [x] T006 [P] vitest `tests/integration/activity.test.ts`: run recording, resume, pagination/since, SSE smoke

## Phase 2: Device attempts and errors (US1-US3)

- [x] T007 `capture/errors.rs` taxonomy, hints, policies, `from_server`, `from_draft`
- [x] T008 `capture_attempt` table and store API; re-enqueue keeps history
- [x] T009 Retry schedule 1m/5m/30m/2h/6h within 24h; config errors wait for the user
- [x] T010 Empty/trivial session guard before any model call; skips store a reason code
- [x] T011 Worker records stages, server `digest_id` and run id; remote drafts become submitted on delivery
- [x] T012 [P] Tests: retry schedule, attempt history, error-code parsing, empty-session guard, config errors

## Phase 3: CLI (US1, US2)

- [x] T013 `pama status` and bare `pama`
- [x] T014 `pama activity [--failed] [--follow]`, `activity show <id>`, `activity retry <id>|--all-failed`
- [x] T015 `pama logs [device|server] [-n] [--follow]`
- [x] T016 `--json` for all of the above; unit tests for timeline/table/run text
- [x] T017 `pama doctor` "digest pipeline" check (device capture state stays on the device)

## Phase 4: Desktop (US5)

- [x] T018 Notify configuration errors, de-duplicated per code per hour (`NotifyGate` + test)
- [x] T019 Background drain follows remote mode; review/inbox counts from the resolved server

## Phase 5: Review fixes

- [x] T023 Retry of a server run is claimed atomically; 409 for a concurrent retry or a run superseded by a newer run of the session; resubmission takes the kept draft atomically; `completeDigest` reuses an already stored version (tests in `activity.test.ts`)
- [x] T024 Empty-session guard counts tool calls as agent activity (FR-006; unit tests in `capture/worker.rs`)
- [x] T025 Later retries on CLI-only installs: owner commands start a drain when a retry is due (`capture::kick_due`); drains recover interrupted captures and refresh their lock; desktop records drafting-model errors on due captures (`Store::fail_due`)

## Deferred

- [ ] T020 Async `202 {run_id}` digest endpoint over the job queue (plan §4.1; optional, not done)
- [ ] T021 Tray icon state on errors (plan §4.3)
- [ ] T022 Spinner/progress for manual `pama scan` / `capture drain` (styling slice)
