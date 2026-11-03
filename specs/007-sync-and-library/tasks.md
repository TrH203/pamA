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

## Review fixes

- [x] T035 Digests carry the owner's task key (`bundle_ref`, gated on `bundle_refs`): the target
  names and files the task the owner sees after a split or merge
- [x] T036 Merge drops pending changes of merged-away tasks and sends the merged state last;
  merging a published task into an unpublished one queues its tombstone; merge dedupes ids
- [x] T037 Split keeps `sync_enabled_at`; turning publish off fails closed when the Ask Link
  check fails (needs `--yes`); `pama tasks merge|split` dedupe repeated ids

## Later (not in this slice)

- [ ] T040 Web Sync page ("Sync now", failed items) and Library page
  - [x] T040a Console Settings → Publish (`apps/web/src/console/pages/settings/Publish.tsx`): projects
    and tasks published and their server, per-project and per-task switches (task override or
    "follows project"), pending queue counts, "connected but nothing is published" banner, and a
    confirm before turning publish off (target from `GET /v1/sync/source`, the
    `pama sync disable` command that lists the affected Ask Links). Server mode shows Sharing.
  - [ ] T040b "Send now" and failed items need a local server route that reaches the device
    outbox; the page shows `pama sync now` / `pama sync failed` with copy buttons until then
  - [x] T040c Console Library (`apps/web/src/console/pages/library/`): `/library/tasks` (one-line
    "what is a Task", per project, branch chips, session count, publish state in local mode,
    inline rename, multi-select merge with confirm), `/library/tasks/:id` (split picked sessions),
    `/library/sessions` and `/library/sessions/:id` (agent badge, times, branches, digest versions
    with a version comparison, withdraw, delete with confirm, move to another task of the project
    via split + merge, Ask Links using the session), `/library/digests` (status/project/task
    filters), `/library/search?q=` (results grouped by task); replaces `console/Bundles.tsx`
  - [x] T040d Review structured editor (spec 008a, `apps/web/src/console/pages/review/`): goal,
    decisions (add/remove/reorder; what, why, rejected alternatives, labels), outcome, open
    items, modules; validated against `session-digest.schema.json` limits before
    `POST /v1/digests/:id/approve` with the edited content; shortcuts a/e/d/j/k with a visible
    hint; replaces `console/Review.tsx` and the raw-JSON textarea
  - [x] T040e Tests: `pages/library/library.test.tsx`, `pages/review/review.test.tsx`
  - [ ] T040f A single "move session to task" server route (today the console splits the session
    out and merges it into the target, two requests that are not atomic)
- [ ] T041 Ask which projects to share right after `pama connect`
- [ ] T042 Offer to move projects when the default server changes
