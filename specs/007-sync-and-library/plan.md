# Implementation Plan: Sync controls and library backend

## Technical context

Rust (`pama-core`, `pama-cli`), TypeScript server (`apps/server`, Hono + Drizzle, PGlite or
Postgres). Migration **0012** only.

## Design

### Server (`apps/server`)
- `migrations/0012_sync_library.sql`: `sync_outgoing.payload jsonb` (BundleChange state queued
  for publish targets), indexes `sessions_ws_ended` and `digests_ws_status` for library lists.
  Drizzle schema mirrors the column.
- `services/library.ts` + `routes/library.ts`: sessions list/detail/delete, digests list,
  search (reciprocal rank fusion of full-text and vector rank over approved digest items).
- `services/sync.ts`: queue the resulting task state on rename/split/merge for each publish
  target; `POST /v1/sync/bundles` ingest (idempotent, moves/pins only known sessions);
  `GET /v1/sync/affected-links`; `GET /v1/sync/source` (local only: target and portable key).
- Keyless (split) tasks use `id:<bundle id>` as portable key in tombstones and changes.
- `/v1/health` capabilities: `bundle_changes`, `affected_links`, `library`.

### Core (`crates/pama-core`)
- `sync::sync_now` (ignores backoff, optional pull), `describe_item`, `nothing_shared`.
- Store: `outbox_dead_items`, `outbox_match_dead` (id prefix), `outbox_revive`, `outbox_drop`,
  `capture_for_session`.
- `HttpRemote`: BundleChange delivery gated on capability, `affected_links`.
- `remote`: per-task overrides in setting `remote.sync_bundles`, `suggest_name` (same rule as the
  server), `bundle_name` in draft payloads.

### CLI (`crates/pama-cli`)
- `sync now|failed|retry|drop`, `--task` (alias `--bundle`), `--yes` on disable.
- `cmd/library.rs`: tasks/sessions/digests/search; `cmd/resolve.rs`: name-or-id resolution
  (exact id → exact name → `context/name` → id prefix ≥ 4 → all words), ambiguity listing.
- `review`: publish after approve in local mode. `doctor`: sharing/publish checks.

## Constitution check

Raw transcripts never leave the machine (only digests, task names and session refs move);
owner-only routes; workspace isolation in every library query; tests for the new ingest path.
