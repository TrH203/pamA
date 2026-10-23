---
description: "Task list for Bundle Names and Multi-Branch Sessions"
---

# Tasks: Bundle Names and Multi-Branch Sessions

**Input**: Design documents from `/specs/002-bundle-names-branches/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included. Constitution V requires failing tests before redaction/policy code, and the
workflow requires contract tests for shared schemas. In each phase the test tasks come first and
MUST fail before the matching implementation tasks start.

**Organization**: Grouped by user story. All of US1–US3 are P1, but US2 (display) reads data that
US3 (recording) produces, so the phases run **US3 → US1 → US2 → US4**. Each phase is still
independently testable (US1 and US3 do not depend on each other; US2 needs US3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: User story the task belongs to (US1–US4)
- Every task names the exact file path(s)

## Path Conventions

Monorepo per plan.md: Rust in `crates/`, TypeScript in `apps/` and `packages/`, evals in `evals/`.
Server tests: `apps/server/tests/{unit,integration,contract}`; Rust tests: `crates/pama-core/tests/`.

---

## Phase 1: Setup

- [X] T001 Record a green baseline before changes: run `cargo test --workspace` and `pnpm --filter @pama/server test` and note any pre-existing failures in the PR description (no file change)
- [X] T002 [P] Create fixture transcripts with branch switches in `crates/pama-core/tests/fixtures/`: `claude-multi-branch.jsonl` (main → feat/login with 30 events → fix/typo with 5 events, `gitBranch` on every record, timestamps increasing), `claude-main-only.jsonl`, `claude-branch-abab.jsonl` (A → B → A), `claude-no-branch.jsonl`, `claude-tie.jsonl` (two branches with equal events), (generated into `fixtures/claude-branches/`); Codex rollouts carry the branch only in `session_meta.git.branch` in all existing fixtures, so Codex is covered with the existing fixtures and yields a one-entry list

---

## Phase 2: Foundational (blocks all user stories)

**Purpose**: Shared schema, types and DB changes every story builds on

### Tests first

- [X] T003 [P] Add digest fixtures in `packages/types/fixtures/`: `digest-valid-branches.json` (git.branch + git.branches with 3 entries incl. first_seen/last_seen/events), `digest-valid-legacy-single-branch.json`, and invalid `digest-invalid-branches-too-many.json` (21 items), `digest-invalid-branches-empty-name.json`, `digest-invalid-branches-unknown-field.json`
- [X] T004 [P] The contract tests are fixture-driven (`crates/pama-core/tests/contract_digest_schema.rs`, `apps/server/tests/contract/digest-schema.test.ts`), so the T003 fixtures extend them automatically; confirm the new valid fixtures FAIL today. JSON Schema cannot express "unique branch names", so add duplicate-name rejection as dedicated tests: a unit test in `crates/pama-core/src/digest.rs` (`#[cfg(test)]`) and a case in `apps/server/tests/contract/digest-schema.test.ts`

### Implementation

- [X] T005 Add migration `apps/server/migrations/0007_bundle_names_branches.sql` (generate the journal/snapshot with `pnpm --filter @pama/server db:generate`): `bundles.name_source text NOT NULL DEFAULT 'key'` with CHECK `IN ('key','suggested','owner')`; `bundles.name_updated_at timestamptz` (set to now() on change); `sessions.bundle_pinned boolean NOT NULL DEFAULT false`; new table `session_branches(session_id text FK→sessions ON DELETE CASCADE, workspace_id text NOT NULL, name text NOT NULL (≤ 256), position int NOT NULL (0-based), first_seen_at timestamptz NULL, last_seen_at timestamptz NULL, event_count int NOT NULL DEFAULT 0 CHECK (event_count >= 0), PRIMARY KEY (session_id, name))`; backfill `name_source = 'key'` where `name = key` else `'owner'`; backfill one `session_branches` row per session from its latest digest's `content->'source'->'git'->>'branch'` when present
- [X] T006 Mirror T005 in `apps/server/src/db/schema/digest.ts` (Drizzle: `bundles.nameSource`, `bundles.nameUpdatedAt`, `sessions.bundlePinned`, new `sessionBranches` table with the same constraints)
- [X] T007 [P] Update `packages/types/schema/session-digest.schema.json` with `source.git.branches` exactly as in `contracts/digest-branches.md` (maxItems 20; item `name` minLength 1 maxLength 256; `additionalProperties:false`; `schema_version` stays 1)
- [X] T008 [P] Add `BranchVisit`/`branches: Option<Vec<…>>` (`#[serde(skip_serializing_if = "Option::is_none")]`, typeshare) to `GitInfo` in `crates/pama-core/src/digest.rs` with validation (≤ 20 items, unique names, name 1–256 chars) and regenerate `packages/types/src/generated.ts` using the typeshare step defined in `packages/types/package.json`
- [X] T009 [P] Add `git.branches` to the zod schema in `apps/server/src/schema/digest.ts` (same limits as T007, refine unique names) and to `TranscriptInput.git` in `apps/server/src/pipeline/transcript.ts`; T004 tests now pass

**Checkpoint**: Contract tests green on both sides; migration applies on PGlite and Postgres.

---

## Phase 3: User Story 3 - A session that switches branches is recorded faithfully (Priority: P1) 🎯 MVP

**Goal**: Every branch a session visited is recorded in order; the session is filed under exactly
one bundle by the agreed rule; re-capture re-evaluates unless the owner moved the session.

**Independent Test**: Feed `claude-multi-branch.jsonl`; the digest request lists all three branches
in order, `bundle_key = feat/login`; a `main`-only session files under `main`; re-capturing after
the final branch changes moves an unpinned session but not a pinned one.

### Tests for User Story 3 (write first, must fail)

- [X] T010 [P] [US3] Write `crates/pama-core/tests/filing_branch.rs` for `project::pick_filing_branch`: most events wins; `main`/`master` ignored when any other branch exists; main-only → `main`; tie → earliest `first_seen`; empty list → `None`; A→B→A counts as one entry
- [X] T011 [P] [US3] Extend `crates/pama-core/tests/adapter_claude.rs` and `adapter_codex.rs`: parse the T002 fixtures, assert ordered `meta.branches` with `first_seen`/`last_seen`/`events`, `meta.git_branch` equals the filing branch, no-branch fixture yields an empty list
- [X] T012 [P] [US3] Extend `crates/pama-core/tests/capture_worker.rs`: `request_body` for the multi-branch session sets `bundle_key` and `git.branch` to the filing branch and `git.branches` to the full list; a single-branch session still sends the legacy shape plus a one-entry list; falls back to `project::current_branch` when no branch was seen
- [X] T013 [P] [US3] Write `apps/server/tests/integration/session-branches.test.ts`: digesting a transcript with `git.branches` writes `session_branches` rows (order, counts, cap of 20 with the filing branch kept), re-capture replaces rows without duplicating the session, an unpinned session is re-filed when `bundle_key` changes (its `digest_items.bundle_id` follows), a pinned session is not, split/merge/move set `bundle_pinned = true`, and a digest with only `git.branch` is stored as a one-entry list

### Implementation for User Story 3

- [X] T014 [US3] Add `BranchVisit { name, first_seen: Option<String>, last_seen: Option<String>, events: u32 }` and `SessionMeta.branches: Vec<BranchVisit>` with an `observe_branch(name, at)` helper (dedupe by name, keep first-seen order, bump `events`) in `crates/pama-core/src/session/event.rs`
- [X] T015 [US3] In `crates/pama-core/src/session/claude.rs` replace the overwrite at the `gitBranch` handling (around line 121) with `meta.observe_branch(...)` for every user/assistant record; keep `git_branch` assigned from the filing branch after parsing
- [X] T016 [US3] In `crates/pama-core/src/session/codex.rs` call `observe_branch` for `session_meta.git.branch` and for any later record that carries git branch info (as found while creating T002 fixtures); keep `git_branch` = filing branch
- [X] T017 [US3] Implement `pick_filing_branch` (rule in research R2) and the 20-branch cap helper in `crates/pama-core/src/project.rs`; T010 passes
- [X] T018 [US3] Update `request_body` in `crates/pama-core/src/capture/worker.rs` (around lines 86–130): `bundle_key`/`git.branch` = filing branch, add `git.branches` (each name capped at 256, list capped at 20 keeping the filing branch); T011/T012 pass
- [X] T019 [US3] In `apps/server/src/services/bundles.ts` add `reevaluateSession(db, sessionId, newKey)` (unpinned sessions only; `assignBundle` then update `sessions.bundle_id` and `digest_items.bundle_id`) and set `bundle_pinned = true` inside `moveSessions` (used by split and merge)
- [X] T020 [US3] In `apps/server/src/pipeline/digest.ts` (around lines 55–120, 150–165): after `cleanAndLabel`, replace the session's `session_branches` rows from `digest.source.git.branches` (or `[git.branch]` when absent) in one transaction, and call `reevaluateSession` when an existing unpinned session arrives with a different `bundle_key`
- [X] T021 [US3] In `apps/server/src/services/sync.ts` (replica ingest, around lines 55–130) write `session_branches` from the incoming digest the same way as T020 and re-evaluate the bundle for unpinned sessions; T013 passes

**Checkpoint**: Branch lists recorded, filed and re-evaluated correctly on device and server.

---

## Phase 4: User Story 1 - Recognize a bundle by a meaningful name (Priority: P1)

**Goal**: Bundles show a readable name (suggested from the first digest's goal), the owner can
rename, owner names are never overwritten, renames reach replicas.

**Independent Test**: First approved digest turns `name_source` from `key` to `suggested` with a
≤ 60-char title; rename sets `owner`; a later digest does not change an owner name; a synced
replica shows the new name.

### Tests for User Story 1 (write first, must fail)

- [X] T022 [P] [US1] Write `apps/server/tests/unit/bundle-names.test.ts` (pure `suggestName`) plus `apps/server/tests/integration/bundle-names.test.ts` (state transitions): `suggestName(goal)` trims to ≤ 60 chars at a word boundary and strips trailing punctuation; empty/whitespace goal → `null`; `key → suggested` only on the first approved digest; `owner` is never overwritten by suggestions; rename/merge/split with a supplied name set `name_source = 'owner'` and bump `name_updated_at`; fallback title stays the key when no digest exists
- [X] T023 [P] [US1] Write `apps/server/tests/integration/bundle-name-sync.test.ts`: (a) replica applies an incoming `bundle_name` when its `name_source <> 'owner'` or the incoming `bundle_name_source` is `owner`; (b) renaming a bundle with sync enabled makes the bundle's latest approved digest re-deliverable, and re-delivering an already-known digest to the replica is idempotent (no duplicate digest/version) — if (b) fails by design, record it and implement the fallback upsert endpoint from research R8

### Implementation for User Story 1

- [X] T024 [US1] Add `suggestName(goal)` and `applySuggestedName(q, bundleId, goal)` (only when `name_source = 'key'`) in `apps/server/src/services/bundles.ts`; call it from `approveDigest` flow in `apps/server/src/pipeline/` after the first approval of a session in the bundle (`approveDigest` in `apps/server/src/services/digests.ts`, line ~150; also covers auto-approve from `pipeline/digest.ts`)
- [X] T025 [US1] Update `renameBundle`, `mergeBundles` (target keeps merged name) and `splitBundle` (new bundle) in `apps/server/src/services/bundles.ts` to set `name_source = 'owner'` and `name_updated_at = now()`; `assignBundle` inserts with `name_source = 'key'`
- [X] T026 [US1] In `apps/server/src/services/sync.ts` add `bundle_name_source` next to `bundle_name` in `pending()` (around lines 225–250) and replace the replica rule `UPDATE bundles SET name = $2 WHERE id = $1 AND name = key` (around line 90) with the research R8 rule; `bundle_name` schema (line ~21) gains optional `bundle_name_source`
- [X] T027 [US1] On owner rename with sync enabled (`apps/server/src/routes/review.ts` PATCH `/bundles/:id`, around line 119 → `renameBundle`), delete the `sync_deliveries` row of the bundle's latest approved digest for its target so it is re-sent (reuse `resetDeliveries` in `apps/server/src/services/sync.ts` narrowed to one digest); T022/T023 pass
- [X] T028 [P] [US1] Update the device sync client in `crates/pama-core/src/sync.rs` (around line 72) to forward `bundle_name_source` from the server's pending payload to the replica request

**Checkpoint**: Names suggested, owner-protected and propagated; US1 testable on its own.

---

## Phase 5: User Story 2 - See which branches a bundle covers (Priority: P1)

**Goal**: Name as title, branch chips, session count and last activity on API, CLI, console and
desktop settings, all from one derived source.

**Independent Test**: A bundle with sessions on `feat/login` and `fix/typo` shows both chips,
"4 sessions" and the latest activity identically in console, desktop settings and `pama sync status`;
after merge/split the numbers update on next load.

### Tests for User Story 2 (write first, must fail)

- [X] T029 [P] [US2] Write `apps/server/tests/integration/list-bundles.test.ts`: `listBundles` returns `name_source`, `branches` (distinct names ordered by earliest first-seen), `session_count`, `last_activity = max(ended_at)`, per-session `branches` and `bundle_pinned`; values are correct after merge, split and a moved session; empty bundles stay hidden; uses a constant number of queries regardless of bundle count
- [X] T030 [P] [US2] Write `apps/web/src/console/bundle-summary.test.ts` (imports `@pama/ui`) (Vitest, node environment; no new test dependencies) for the pure helpers `summarizeBundle()` exported from `packages/ui/src/bundleSummary.ts`: title is the name and falls back to the key, at most 3 chips plus an overflow count, "1 session"/"N sessions", relative last-activity text, `null` last activity handled
- [X] T031 [P] [US2] Add CLI output unit tests (the CLI is a bin crate, so they live in `crates/pama-cli/src/cmd/bundle_fmt.rs`) for the formats in `contracts/cli.md`: `pama review` bundle column with `[branch +N]` hint (`/v1/review` now returns each draft's `branches`) and `pama sync status` line; `--json` output is unabridged

### Implementation for User Story 2

- [X] T032 [US2] Rewrite `listBundles` in `apps/server/src/services/bundles.ts` to add `name_source`, `branches`, `session_count`, `last_activity` and per-session `branches`/`bundle_pinned` using one grouped query over `session_branches` (research R4); keep existing fields; T029 passes
- [X] T033 [US2] Expose the same summary fields (`branches`, `session_count`, `last_activity`) in `apps/server/src/routes/sync-local.ts` (bundle rows around lines 22–35, order by name as today) so desktop settings and `pama sync status` need no own computation
- [X] T034 [P] [US2] Update the TypeScript shapes in `apps/web/src/console/types.ts` (`Bundle`) and `apps/web/src/desktop/Settings.tsx` (bundle row type, line ~13)
- [X] T035 [P] [US2] Create `packages/ui/src/bundleSummary.ts` (pure `summarizeBundle()` helper) and `packages/ui/src/BundleSummary.tsx` (name title, branch chips with expandable `+N more`, session count, relative last activity; styled like `AutomatedBadge.tsx`), export both from `packages/ui/src/index.ts`; T030 passes
- [X] T036 [US2] Use `BundleSummary` in `apps/web/src/console/Bundles.tsx` (replace the header around line 60; keep merge/split/rename controls and the rename `PATCH` call) and in the desktop bundle list in `apps/web/src/desktop/Settings.tsx` (around line 189)
- [X] T037 [P] [US2] Update `crates/pama-cli/src/cmd/review.rs` (around line 98) and `crates/pama-cli/src/cmd/sync.rs` (around lines 72–95) to print name, branches (3 + `+N more`), session count and last activity per `contracts/cli.md`; T031 passes

**Checkpoint**: US2 complete; surfaces agree (SC-004).

---

## Phase 6: User Story 4 - Branch names stay private and old data keeps working (Priority: P2)

**Goal**: Branch names and bundle names are redacted before leaving; legacy digests/clients and
older servers keep working.

**Independent Test**: Sync a session on branch `acme-corp/AKIAIOSFODNN7EXAMPLE-deal`; the stored digest,
`session_branches` rows and the `pending()` payload contain only the masked form; a pre-feature digest
and an old client's single-branch digest still ingest and display.

### Tests for User Story 4 (write first, must fail)

- [X] T038 [P] [US4] Write `apps/server/tests/unit/branch-redaction.test.ts` (also masks the bundle tombstone key): a branch name containing a planted secret and one containing PII are masked in (a) the stored digest `source.git.branches[].name`/`bundle_key`/`git.branch`, (b) `session_branches.name`, (c) `pending()` output including `bundle_name`; with sync off nothing is in `pending()`
- [X] T039 [P] [US4] Write `apps/server/tests/integration/branch-compat.test.ts`: the pre-feature digest fixture (`digest-valid-legacy-single-branch.json`) and a transcript from an old client (only `bundle_key` + `git.branch`) ingest successfully and display exactly one branch; a migrated database (rows from before `0007`) lists bundles with `name_source` backfilled and one branch per session
- [X] T040 [P] [US4] Write `crates/pama-core/tests/sync_branch_skew.rs`: when the target server's capability info lacks branch-list support the sync client strips `git.branches` (leaves `git.branch`/`bundle_key`) before sending; when it advertises support the list is sent

### Implementation for User Story 4

- [X] T041 [US4] Redact `bundle_name` and bundle tombstone keys with the existing rule set (`rules.redact`, as in `sanitizeDeep` in `apps/server/src/pipeline/classify.ts`) inside `pending()` in `apps/server/src/services/sync.ts`; confirm `cleanAndLabel` already covers `source.git.branches[].name` (walks all strings) and fix it if a field is skipped; T038 passes
- [X] T042 [US4] Advertise branch-list support in the server's existing version/health response (locate it under `apps/server/src/app.ts` / `routes/`; add a `capabilities` entry such as `branch_lists`) and make the Rust sync client in `crates/pama-core/src/sync.rs` read it and strip `git.branches` when absent; T040 passes
- [X] T043 [US4] Confirm the legacy paths (no code change needed; covered by `branch-compat.test.ts`): `apps/server/src/services/sync.ts` and `apps/server/src/pipeline/digest.ts` treat a missing `git.branches` as `[git.branch]`; fix any gap found by T039
- [X] T044 [P] [US4] Verify asker-facing routes do not expose `session_branches` or bundle names beyond today’s scoped output by adding assertions to `apps/server/tests/contract/public-api.test.ts`

**Checkpoint**: Privacy and compatibility verified; all stories complete.

---

## Phase 7: Polish & Cross-Cutting

- [X] T045 [P] Update `specs/001-pama-mvp/data-model.md` (bundles/sessions notes) and `specs/001-pama-mvp/contracts/session-digest.schema.json` copy, plus `docs/` and `README.md` mentions of bundles, to describe names and branch lists; add the upgrade note “upgrade self-host servers before devices” to `docs/` (version-skew rule in research R3)
- [X] T046 Run the full quality gate (`pnpm lint` also flags the git-ignored, locally generated `crates/pama-desktop/src-tauri/gen/**` files — not part of the repo; `pnpm evals` reports 0 leaks and one pre-existing quality failure, `answer-refund-why`, identical on the unmodified HEAD): `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace`, `pnpm typecheck`, `pnpm lint`, `pnpm --filter @pama/server test`, and `pnpm evals` (must report 0 leaks since `apps/server/src/pipeline/` changed)
- [X] T047 Walk through [quickstart.md](./quickstart.md) against the demo seed (`apps/server/src/demo/seed.ts` now gives session `refund-2` a second branch). Verified through the API of a running demo server (`/v1/bundles`, `/v1/sync/status`, `/v1/health`); the browser console, desktop app and the `pama` binary were not driven by hand — their formatting is covered by unit tests
- [X] T048 Check SC-006: there is no real pre-feature PGlite data directory on this machine (`~/.pama` only holds the SQLite outbox), so a database was built in its exact pre-`0007` shape (migrations 0000–0006 plus old-style rows), then `0007` applied: names and keys unchanged, `name_source` backfilled (`key`/`owner`), one `session_branches` row per session from its latest digest, sessions without a branch get none

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2** first. Phase 2 blocks everything (migration, schemas, types).
- **US3 (Phase 3)** depends only on Phase 2. **US1 (Phase 4)** depends only on Phase 2 and can run in parallel with US3 (different files except `services/bundles.ts` and `services/sync.ts`, which both touch — sequence T019/T020/T021 before T024–T027 or coordinate on those files).
- **US2 (Phase 5)** depends on US3 (needs `session_branches` data) and on US1 for `name_source` display.
- **US4 (Phase 6)** depends on US3 and US1 (redacts what they produce).
- **Polish** last.
- Within a phase: tests first (must fail) → models/types → services → routes/UI/CLI.

### Parallel opportunities

- Phase 2: T003 ∥ T007 ∥ T008 ∥ T009 (after T004 written).
- US3: T010 ∥ T011 ∥ T012 ∥ T013 (tests); then T014→T015/T016 (Rust) ∥ T019 (server).
- US1: T022 ∥ T023; T028 ∥ server tasks.
- US2: T029 ∥ T030 ∥ T031; T034 ∥ T035 ∥ T037.
- US4: T038 ∥ T039 ∥ T040 ∥ T044.

## Implementation Strategy

- **MVP**: Phase 1 + 2 + US3 (correct data) + US1 (names) → owners already see better names with the
  one-bundle-per-session rule fixed; add US2 for the full chips display.
- **Incremental**: land per phase as separate PRs (Conventional Commits, e.g.
  `feat(core): record every branch a session visits`), each passing the CI gates.
- **Risk first**: T023(b) (idempotent re-delivery for rename propagation) and T016 (Codex per-turn
  branch data) are the two unknowns; do them early in their phases.
