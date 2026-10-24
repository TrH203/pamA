# Tasks: Thin Client (CLI-only install, remote server)

**Input**: Design documents from `/specs/004-thin-client/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: required for safety-critical code (Constitution V): auth middleware, workspace
isolation, on-device redaction of drafter output, draft output contract.

## Phase 1: Setup

- [x] T001 Add migration `apps/server/migrations/0009_thin_client.sql`: table `device_auth_requests` (device_code_hash PK, user_code unique, device_name, status CHECK IN ('pending','approved','denied','consumed'), workspace_id, device_id, token_once, expires_at, created_at), `login_tokens.next text`, `digests.origin_device_id text`, `digests.review_seq bigint` (trigger + sequence), table `workspace_model_settings` (workspace_id, role CHECK = 'chat', config jsonb, updated_at, PK(workspace_id, role)) (raw SQL like 0008; no drizzle mirror)
- [x] T002 [P] Add shared draft fixture `packages/types/fixtures/draft/basic.json` (normalized events + model reply + expected SessionDigest minus provenance timestamps)

## Phase 2: Foundational

- [x] T003 Write failing tests in `apps/server/tests/unit/auth-device-token.test.ts`: device token accepted on owner routes in its own workspace; local-only routes still 403 on servers; revoked token 401; device of workspace A cannot read workspace B resources
- [x] T004 Accept device tokens on owner routes in `apps/server/src/auth/index.ts` (act in device workspace, touch `last_seen_at`)
- [x] T005 Generalize `LocalApi` into `Api` with `Target::{Local, Remote{url}}` resolution (mode setting, `--server`, keychain token, `NotLoggedIn` error) in `crates/pama-core/src/client.rs`; keep `LocalApi` as alias
- [x] T006 Add `crates/pama-core/src/remote.rs`: settings helpers (`mode`, `remote.servers`, default server, `remote.sync_projects`) with unit tests
- [x] T007 Wire global `--server` and `Api::connect` into every CLI command (`crates/pama-cli/src/cmd/{review,link,inbox,model,sync,doctor}.rs`), map `NotLoggedIn` to exit 2

## Phase 3: User Story 1 — Login (P1)

**Goal**: one command connects a machine. **Independent test**: login against a test server, approve, `pama mode` shows remote; logout revokes.

- [x] T008 [US1] Write failing tests `apps/server/tests/unit/device-flow.test.ts` (start → pending 428 → approve → token once → 410 after; deny → 403; expiry → 410; local mode 404)
- [x] T009 [US1] Implement `apps/server/src/auth/device-flow.ts` (start, token, lookup, approve, deny, console-link) and register public paths in `apps/server/src/auth/index.ts` and routes in `apps/server/src/app.ts`; health capabilities `device_login`, `drafts`, `changes`
- [x] T010 [US1] Support `next` in `/v1/auth/login` + callback redirect in `apps/server/src/auth/magic-link.ts`
- [x] T011 [P] [US1] Add `apps/web/src/console/DeviceApprove.tsx`, `?device=` route in `apps/web/src/console/main.tsx`, `next` in `apps/web/src/console/Login.tsx`
- [x] T012 [US1] Device login client (start, poll, store token) in `crates/pama-core/src/remote.rs`
- [x] T013 [US1] `pama login`, `pama logout`, `pama mode` in `crates/pama-cli/src/main.rs` and `crates/pama-cli/src/cmd/login.rs`

## Phase 4: User Story 2 — Draft on device (P1)

**Goal**: sessions become drafts on the remote server with no local server. **Independent test**: end a session in remote mode → draft on server, no pama-server process.

- [x] T014 [US2] Write failing tests for `crates/pama-core/src/draft/mod.rs`: `format_transcript` parity (head/tail budget), caps, every output string re-masked by Layer 1 (seeded secret in model reply never survives), fixture T002 parity
- [x] T015 [US2] Implement `crates/pama-core/src/draft/mod.rs` (prompt embedded from `prompts/digest.md`, schema, `build_digest`) and `crates/pama-core/src/draft/llm.rs` (Anthropic tool call, OpenAI-compatible json_object, Ollama format) via `GuardedClient`
- [x] T016 [US2] Add store support in `crates/pama-core/src/store/`: draft-flagged outbox payloads, table `remote_digest` (target, agent, agent_session_id PK; project_key, digest, status IN ('draft','approved','discarded','deleted'), server_digest_id, version, updated_at)
- [x] T017 [US2] `RemoteSink` (DigestSink) in `crates/pama-core/src/sync.rs`: gate on `remote.sync_projects`, draft, store local copy, enqueue the draft; `HttpRemote` delivers to `/v1/sync/drafts`
- [x] T018 [US2] Server: `ingestDraft` in `apps/server/src/services/sync.ts` + `POST /v1/sync/drafts` in `apps/server/src/routes/sync.ts` (+ DEVICE path); tests in `apps/server/tests/unit/sync-drafts.test.ts`
- [x] T019 [US2] `capture drain` in remote mode uses `RemoteSink`, never starts a local server, delivers and pulls changes in `crates/pama-cli/src/cmd/capture.rs`
- [x] T020 [US2] Port the TS side of fixture T002 into `apps/server/tests/unit/draft-parity.test.ts`

## Phase 5: User Story 3 — Remote commands (P1)

- [x] T021 [US3] `pama console` in remote mode via `/v1/auth/device/console-link` in `crates/pama-cli/src/cmd/server.rs`
- [x] T022 [US3] `pama sync status|enable|disable` remote behaviour (device sync list, tombstones) in `crates/pama-cli/src/cmd/sync.rs`
- [x] T023 [US3] `pama model --device` targets the drafting model settings on the device in `crates/pama-cli/src/cmd/model.rs`

## Phase 6: User Story 4 — Web review + pull-back (P2)

- [x] T024 [US4] Bump `review_seq` on every status change (trigger in the migration); `changesSince` + `GET /v1/sync/changes` in `apps/server/src/services/sync.ts` and `apps/server/src/routes/sync.ts`; tests
- [x] T025 [US4] Show origin device in review list (`apps/server/src/routes/review.ts`, `apps/web/src/console/Review.tsx`)
- [x] T026 [US4] Pull-back on device (`pull_changes`, throttled 60 s) in `crates/pama-core/src/remote.rs`, called from `Api::connect` remote and drain

## Phase 7: User Story 5 — Mode selection (P2)

- [x] T027 [US5] `pama init --mode local|remote [--sync]` in `crates/pama-cli/src/cmd/init.rs`
- [x] T028 [US5] `pama doctor` reports mode, servers, login validity, drafting model, pending deliveries in `crates/pama-cli/src/cmd/doctor.rs`

## Phase 8: User Story 6 — Cloud operation (P3)

- [x] T029 [US6] Per-workspace chat model override in cloud mode: `apps/server/src/llm/workspace-models.ts`, `apps/server/src/routes/models.ts`, models resolved per request in `apps/server/src/auth/index.ts`; tests
- [x] T030 [P] [US6] `docs/deploy-cloud.md` (compose with PAMA_MODE=cloud, HTTPS proxy, SMTP, secrets, models, backups, upgrades)

## Phase 9: Polish

- [x] T031 Update `specs/001-pama-mvp/contracts/cli.md` pointer + `README.md` remote-mode quickstart
- [x] T032 Run `cargo fmt`, `cargo clippy -D warnings`, `cargo test`, `pnpm -r lint typecheck test`; fix failures

## Dependencies

Setup → Foundational → US1 → US2 → US3; US4 needs US2; US5 needs US1+US2; US6 independent after Foundational.

## Parallel examples

- T002, T011, T030 can run alongside server work.
- Within US2: T014/T015 (Rust) and T018 (TS) are independent.

## Implementation strategy

MVP = US1 + US2 + US3 (thin client usable end to end); then US4, US5, US6.
