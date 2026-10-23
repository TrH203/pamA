# Implementation Plan: Bundle Names and Multi-Branch Sessions

**Branch**: `002-bundle-names-branches` | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-bundle-names-branches/spec.md`

## Summary

A bundle gets a human-readable name (derived from its first digest's goal, owner-renamable, tracked
by a `name_source`), and a session that switches git branches records every branch it visited.
Device parsers (Rust) count events per branch while reading the transcript and pick the filing
branch once (ignore `main`/`master` when another exists; tie → earliest). The digest gains an
optional `source.git.branches[]` (additive, schema_version stays 1). The server stores the list in a
new `session_branches` table, so a bundle's branch chips, session count and last activity are
*derived* by query and stay correct after split/merge/move. Re-capturing a session re-evaluates its
bundle unless the owner moved it (`sessions.bundle_pinned`). Branch names reach the server already
inside the digest's strings, so the existing Layer-2 `sanitizeDeep` redacts them at ingest; the
bundle name pushed to a replica is redacted on egress. CLI, console and desktop settings render
name + chips through one shared component. See [research.md](./research.md).

## Technical Context

**Language/Version**: Rust stable (edition 2021, MSRV 1.85); TypeScript 5.x on Node.js 24 LTS.

**Primary Dependencies**: no new dependencies. Reuses serde/typeshare (Rust↔TS types), Drizzle +
SQL migrations (`apps/server/migrations`), Hono routes, zod 4, React 19 + Tailwind, clap.

**Storage**: PostgreSQL 16 / PGlite. One new table (`session_branches`) and three new columns
(`bundles.name_source`, `bundles.name_updated_at`, `sessions.bundle_pinned`) via migration `0007`.
Device SQLite outbox unchanged.

**Testing**: `cargo test` (parser fixtures with branch switches, filing-branch unit tests, schema
contract test); Vitest (digest schema contract, assign/re-evaluate, rename/auto-name, listBundles
derivation, sync egress redaction); server test `branch-redaction` (digest, `session_branches`, sync egress); existing `evals/` suite as a 0-leak regression gate (pipeline code changes); Playwright not needed.

**Target Platform**: unchanged (macOS/Windows desktop, Linux server, browsers).

**Project Type**: Desktop app + CLI + web service (existing monorepo).

**Performance Goals**: parsing overhead for branch counting negligible against the existing
≥ 20 MB/s parse target (one map update per event); bundle list for a workspace of ≤ 1k bundles
renders in one request with two queries (no per-bundle queries).

**Constraints**: branch names ≤ 256 chars (existing limit); ≤ 20 recorded branches per session
(cap); raw transcripts still never leave the device; sync off ⇒ nothing sent; old digests and old
clients keep working.

**Scale/Scope**: MVP dogfood scale (3–5 owners; ≤ 10k digest items per workspace).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Pre-research | Post-design |
|---|---|---|---|
| I. Local-first & privacy | Nothing new leaves the device unless sync is on; no telemetry | ✅ branch list is part of the digest, which already syncs only per opt-in source | ✅ `session_branches` is replicated only via the digest; bundle name redacted on egress (R6) |
| II. Redaction & scope | Branch names redacted; scope in data layer | ✅ digest strings already pass Layer 2 | ✅ `sanitizeDeep` covers `git.branches[].name`; asker-facing routes never select `session_branches` or bundle names outside existing scope filters (contracts/http-api.md) |
| III. Platform independence | No bots, no auto-send | ✅ not touched | ✅ |
| IV. One codebase | Logic once, in TS server; Rust only on device | ⚠️ filing-branch rule lives in Rust | ✅ justified in R2: only the device sees per-event branch data; server consumes `bundle_key` as today, so no duplicate rule |
| V. Test-first safety code | Tests before redaction/policy code | ✅ | ✅ tasks put branch-redaction and filing-rule tests first |
| VI. Simplicity | No new services; YAGNI | ✅ | ✅ name comes from existing digest goal (no extra LLM call); one table, derived views |
| Licensing | No copyleft | ✅ | ✅ no new deps |

Result: **PASS**. No Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/002-bundle-names-branches/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── digest-branches.md      # additive digest/ingest fields + compat rules
│   ├── http-api.md             # /v1/bundles response, rename, name_source
│   └── cli.md                  # `pama review`/`pama sync status` output
└── tasks.md                    # created by /speckit-tasks
```

### Source Code (repository root)

```text
crates/pama-core/
├── src/session/event.rs        # BranchVisit, SessionMeta.branches
├── src/session/claude.rs       # collect branches per event (not overwrite)
├── src/session/codex.rs        # session_meta branch + turn_context/git updates
├── src/project.rs              # pick_filing_branch(), branch cap
├── src/capture/worker.rs       # request_body: bundle_key = filing branch, git.branches
├── src/digest.rs               # GitInfo.branches (typeshare), validation
└── tests/                      # adapter_claude/codex, new filing_branch.rs, contract_digest_schema

crates/pama-cli/src/cmd/        # review.rs, sync.rs: show name + branches

apps/server/
├── migrations/0007_bundle_names_branches.sql (+ meta snapshot)
├── src/db/schema/digest.ts     # sessionBranches table, new columns
├── src/schema/digest.ts        # zod: git.branches
├── src/pipeline/transcript.ts  # TranscriptInput.git.branches
├── src/pipeline/digest.ts      # store branches, re-evaluate bundle, suggest name
├── src/services/bundles.ts     # assign/re-evaluate, rename(name_source), listBundles derived
├── src/services/sync.ts        # ingest branches; redact bundle_name on egress; name propagation
├── src/routes/review.ts        # bundle list shape, rename
├── src/routes/sync-local.ts    # bundle name in sync status
└── tests/{unit,integration,contract}

packages/types/                 # schema JSON + generated.ts (typeshare)
packages/ui/src/BundleSummary.tsx   # name + branch chips + count + last activity
apps/web/src/console/{Bundles.tsx,types.ts}
apps/web/src/desktop/Settings.tsx
```

**Structure Decision**: extend the existing Cargo + pnpm monorepo in place; one shared React
component in `packages/ui` serves both console and desktop-settings surfaces so they cannot drift
(SC-004).

## Complexity Tracking

No constitution violations to justify.
