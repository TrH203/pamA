# Feature Specification: Sync controls and library backend

**Feature Branch**: `feat/007-sync-library` (spec 007 plus the library backend of plan §6.3)

**Created**: 2026-10-31

**Status**: Implemented (backend + CLI; web pages are a later slice)

**Input**: docs/plans/v0.2-overhaul.md §5 (decision: Publish) and §6.3 (library API and CLI).

## Overview

A machine drafts digests; its **home** (the local server in local mode, a pamA server in remote
mode) is where review, Ask Links and answers live. In local mode, **Publish** is the one-way copy
of approved digests of chosen projects or tasks to another server; edits there never come back.
Users see "Task" for what the code and API call a bundle.

This slice makes sharing observable and controllable (send now, failed items, retry, warnings),
carries task renames, splits and merges to publish targets, and adds a library API and CLI to
browse sessions, digests and tasks and to search approved items.

### Terms

- **Home**: where the owner's review and Ask Links live (local or server).
- **Publish**: local mode only; one-way copy of approved digests to a server.
- **Task**: user-facing name of a bundle (sessions grouped by the work, by git branch at first).

## User Scenarios & Testing

### User Story 1 - Send now and see what failed (Priority: P1)

As an owner I run `pama sync now` and see how many items were sent, are waiting for the network,
or failed; `pama sync failed` lists refused items with the server's error, and I can retry or drop
them.

**Acceptance**:
1. Items in backoff are delivered by `sync now` without waiting; the summary counts sent,
   retrying, dead and pending items.
2. In remote mode `sync now` also pulls review decisions back.
3. `sync failed` shows id, kind, target, what the item is (e.g. "digest shop / feat/a: Refunds")
   and `last_error`; `sync retry <id-prefix>|--all` re-queues; `sync drop <id>` deletes.

### User Story 2 - Publish on approve (Priority: P1)

Approving a digest of a published project in local mode publishes it immediately instead of at
the next background tick; the CLI prints "published N item(s)".

### User Story 3 - Warn when nothing is shared (Priority: P1)

In both modes, `pama doctor` and `pama sync status` warn "connected to <server> but nothing is
shared yet" when a server is configured but no project or task is shared.

### User Story 4 - Per-task sharing and task names in remote mode (Priority: P2)

`pama sync enable|disable --task <name>` shares or keeps back one task independent of its
project (spec 004 FR-012). Drafts carry a suggested task name so the server's review list shows
readable names.

### User Story 5 - Task changes reach publish targets (Priority: P2)

Renaming, splitting or merging a task at home queues a `BundleChange` with the resulting state;
the receiving server applies it idempotently (moves and pins only sessions it has). Servers that
do not advertise `bundle_changes` are not sent the change; it fails with a readable error.

### User Story 6 - Warn before links lose sources (Priority: P2)

`pama sync disable` asks the target which Ask Links would lose sources, prints them (marking
links left empty) and requires `--yes`.

### User Story 7 - Library (Priority: P1)

`pama tasks list|show|rename|merge|split`, `pama sessions list|show|delete`,
`pama digests list|show` and `pama search <query>` accept names or ids; an ambiguous name lists
the candidates with ids. Every command supports `--json`.

## Requirements

- **FR-001**: `pama sync now` delivers all pending outbox items regardless of backoff and returns
  a summary; remote mode additionally pulls changes.
- **FR-002**: Dead outbox items are listable with `last_error`, retryable by id, id prefix or
  `--all`, and droppable.
- **FR-003**: Local mode publishes right after an approve made from the CLI.
- **FR-004**: `doctor` and `sync status` warn when connected but nothing is shared, in both modes.
- **FR-005**: Remote mode sends `bundle_name` (suggested from the goal) with drafts; the server
  keeps the first suggestion and never overrides an owner name.
- **FR-006**: Remote mode supports a per-task sync override that wins over the project setting.
- **FR-007**: `BundleChange` outbox items are delivered to `POST /v1/sync/bundles`, gated on the
  `bundle_changes` capability; ingest is idempotent per `outbox_id`.
- **FR-008**: `GET /v1/sync/affected-links?source_type=&source_key=` lists links that would lose
  sources; the CLI prints them and requires `--yes` to proceed.
- **FR-009**: `GET /v1/sessions` (filters project, bundle, agent, status; `limit`/`offset`) and
  `GET /v1/sessions/:id` (agent, times, branches, digest versions, links using it; the CLI adds
  capture status from the device store).
- **FR-010**: `GET /v1/digests?status=&project=&bundle=`.
- **FR-011**: `GET /v1/search?q=` hybrid full-text + vector search over approved digest items,
  owner-wide, returning items with digest, session and task refs.
- **FR-012**: `DELETE /v1/sessions/:id` deletes a session and its digests; a published session
  queues a tombstone to its target.
- **FR-013**: User-facing text says Publish and Task; code and API keep bundle.

## Success Criteria

- **SC-001**: An owner can find why an item did not reach the server and resend it with two
  commands (`sync failed`, `sync retry`).
- **SC-002**: A renamed task shows its new name on the publish target after the next delivery.
- **SC-003**: No command requires looking up an id in `sync status` first.
- **SC-004**: Server vitest and Rust tests cover the new routes, BundleChange ingest, sync now,
  failed/retry/drop and name resolution.

## Out of scope (this slice)

Web Sync and Library pages, colours in CLI output, asking which projects to share right after
`pama connect`, and moving projects when the default server changes.
