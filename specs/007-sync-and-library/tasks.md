# Tasks: Sync controls and library backend

## Phase 1: Server

- [x] T001 Migration `0012_sync_library.sql` + drizzle schema (`sync_outgoing.payload`, library indexes)
- [x] T002 Library service and routes: `GET /v1/sessions`, `GET /v1/sessions/:id`, `DELETE /v1/sessions/:id`, `GET /v1/digests`, `GET /v1/search`
- [x] T003 Queue BundleChange on task rename/split/merge for publish targets; `POST /v1/sync/bundles` ingest
- [x] T004 `GET /v1/sync/affected-links`, `GET /v1/sync/source`; health capabilities
- [x] T005 Drafts accept a suggested task name
- [x] T006 [P] Tests: `tests/integration/library.test.ts`, `tests/integration/bundle-change-sync.test.ts`

## Phase 2: Core

- [x] T010 `sync_now` with summary; delivery ignores backoff
- [x] T011 Dead outbox list/match/revive/drop
- [x] T012 BundleChange delivery gated on `bundle_changes`; `affected_links` client
- [x] T013 Remote per-task sync overrides; `bundle_name` in drafts
- [x] T014 [P] Tests: `tests/sync_now.rs`, `tests/thin_client.rs`, unit tests in `remote.rs`

## Phase 3: CLI

- [x] T020 `pama sync now|failed|retry|drop`; disable lists affected links and needs `--yes`
- [x] T021 Publish after approve (local mode)
- [x] T022 "Connected but nothing is shared yet" in `doctor` and `sync status`, both modes
- [x] T023 `pama tasks list|show|rename|merge|split`
- [x] T024 `pama sessions list|show|delete`, `pama digests list|show`, `pama search`
- [x] T025 Name-or-id resolution with fuzzy disambiguation + tests (`cmd/resolve.rs`)
- [x] T026 User-facing text: Publish, Task

## Phase 4: Docs

- [x] T030 README, `docs/self-host.md`, `docs/deploy-cloud.md` describe Publish, tasks and the new commands

## Later (not in this slice)

- [ ] T040 Web Sync page ("Sync now", failed items) and Library page
- [ ] T041 Ask which projects to share right after `pama connect`
- [ ] T042 Offer to move projects when the default server changes
