# Implementation Plan: Thin Client (CLI-only install, remote server)

**Branch**: `004-thin-client` | **Date**: 2026-10-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-thin-client/spec.md`

## Summary

Add a **remote mode** to the `pama` CLI: the machine keeps only the `pama` binary (capture hooks,
Layer-1 redaction, on-device digest drafting, device store, outbox); review, Ask Links, inbox,
audit and console live on a remote pamA server (cloud or self-host). Technical approach:

1. **Device login** — an RFC 8628-style device authorization flow on the server
   (`/v1/auth/device/*`), approved in the web console after the existing email sign-in; the CLI
   stores the resulting device token in the OS keychain (`pama login`, `pama logout`).
2. **Device token = owner of its workspace** — the auth middleware accepts a device token on owner
   routes (except local-only routes), so every existing owner endpoint works for the CLI unchanged.
3. **One API client** — `pama_core::client::LocalApi` becomes `Api`, resolving either the local
   sidecar (`server.json`) or a remote server (`--server` / default server + keychain token).
   Every CLI command switches to `Api::connect`.
4. **On-device drafter** — a new `pama_core::draft` module ports the server's digest step
   (transcript formatting, `prompts/digest.md`, draft schema, limits) to Rust and calls Anthropic,
   OpenAI-compatible or Ollama directly. A `RemoteSink` implements the existing `DigestSink`
   trait: draft → keep a local copy (source of truth) → outbox `digest_upsert` flagged `draft` → `POST
   /v1/sync/drafts`. Raw and redacted transcripts never leave the machine; only the digest does.
5. **Review pull-back** — `GET /v1/sync/changes?since=` returns review decisions made on the
   server; the device applies them to its local copies (FR-025).
6. **Per-workspace answering model** — in cloud mode an owner may override the chat model for
   their workspace (encrypted key); otherwise the operator's model is used (FR-026).
7. **Console from CLI** — `POST /v1/auth/device/console-link` mints a one-time sign-in link.
8. **Docs** — cloud deployment guide and updated CLI contract.

## Technical Context

**Language/Version**: Rust stable (edition 2021) for `pama-core`/`pama-cli`; TypeScript on
Node.js 24 LTS for `apps/server` and `apps/web`.

**Primary Dependencies**: existing only — reqwest (blocking, json), serde, rusqlite, keyring-core
(Rust); Hono, zod, node-postgres/PGlite, Vercel AI SDK (TS). No new dependencies.

**Storage**: device SQLite store (new tables `remote_digest`, draft-flagged outbox items,
settings keys for mode/servers); server Postgres/PGlite (new migration `0009_thin_client.sql`:
`device_auth_requests`, `login_tokens.next`, `digests.origin_device_id`,
`workspace_model_settings`).

**Testing**: `cargo test` (unit + integration with a mock HTTP server via `std::net::TcpListener`),
`vitest` for server routes and services, existing `evals/` red-team suite.

**Target Platform**: macOS, Windows (CLI); Linux containers (server).

**Project Type**: CLI + web service + web app (monorepo).

**Performance Goals**: hook returns within the 1.5 s budget (unchanged: enqueue + detached
drain); login completes ≤ 5 s after approval (poll interval 2 s); offline drafts delivered within
1 min of reconnect (drain backoff ≤ 60 s while pending).

**Constraints**: raw/redacted transcripts never sent to the pamA server; drafting LLM call only to
the configured provider and only after Layer-1 redaction; no background daemon in remote mode;
binary size < 30 MB.

**Scale/Scope**: cloud: thousands of workspaces, each 1–5 devices; device: ≤ 50 captures/drain.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Local-first & privacy | PASS | Transcripts (raw and redacted) stay on the device; only drafted digests leave, and only for projects with sync enabled on the device (off by default, explicit at init). Device keeps a copy of every digest and is the source of truth; server decisions are pulled back; device tombstones always win. Local mode untouched and still fully offline-capable. Strict offline applies to the drafter's model calls (GuardedClient). |
| II. Redaction & scope | PASS | Layer 1 runs on device before the drafting LLM call (same `RuleSet`); the draft is re-masked on device; Layer 2 runs at server ingest (`cleanAndLabel`) exactly as for synced digests; Layer 3 unchanged. Workspace isolation in the data layer: device token → `workspaceId` in deps, all queries already filter by workspace; isolation tests added. |
| III. Platform independence | PASS | No chat platform; console approval is web. |
| IV. One codebase, three deployments | PASS w/ note | Answer pipeline unchanged (TS, server). Digest *drafting* gains a Rust implementation for remote mode; see Complexity Tracking. Same server image in all modes. |
| V. Test-first | PASS | Drafter redaction/masking and the auth middleware change (device token on owner routes, local-only still refused, cross-workspace refusal) get failing tests first. Shared drafter output contract tested in both languages via a fixture. |
| VI. Simplicity | PASS | No new services or dependencies; reuses outbox, receipts, tombstones, magic link, `DigestSink`. |

## Project Structure

### Documentation (this feature)

```text
specs/004-thin-client/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-api.md
│   └── cli.md
└── tasks.md
```

### Source Code (repository root)

```text
crates/pama-core/src/
├── client.rs            # LocalApi → Api (local sidecar or remote server), Target resolution
├── remote.rs            # NEW: mode/servers, device login, RemoteSink, changes pull-back
├── draft/               # NEW: on-device drafter
│   ├── mod.rs           #   format_transcript, build SessionDigest, limits, masking
│   └── llm.rs           #   Anthropic / OpenAI-compatible / Ollama JSON calls via GuardedClient
├── sync.rs              # draft-flagged outbox items → /v1/sync/drafts
└── store/               # remote_digest table, outbox kind, helpers

crates/pama-cli/src/
├── main.rs              # login, logout, mode commands; --server wired
└── cmd/                 # login.rs NEW; capture/review/link/inbox/model/sync/doctor/server use Api

apps/server/
├── migrations/0009_thin_client.sql
└── src/
    ├── auth/index.ts            # device token on owner routes
    ├── auth/device-flow.ts      # NEW: /v1/auth/device/{start,token,approve,deny,lookup,console-link}
    ├── auth/magic-link.ts       # `next` redirect
    ├── routes/sync.ts           # /v1/sync/drafts, /v1/sync/changes
    ├── services/sync.ts         # ingestDraft, changesSince
    ├── llm/workspace-models.ts  # NEW: per-workspace chat override (cloud)
    └── routes/models.ts         # workspace scope in cloud mode

apps/web/src/console/
├── DeviceApprove.tsx    # NEW
├── Login.tsx            # passes `next`
└── main.tsx             # ?device= route

docs/deploy-cloud.md     # NEW
```

**Structure Decision**: extend the existing crates/apps; no new packages.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Digest drafting exists in TS (local mode) and Rust (remote mode) | Remote mode must not send transcripts to the server and must not need Node on the device | Sending redacted events to the server violates Principle I; shipping Node to the device defeats the feature. Drift is contained: both read `prompts/digest.md` (embedded in the Rust binary at build time), share the draft schema/limits, and a shared fixture test (`packages/types/fixtures/draft/*`) asserts identical `SessionDigest` output from the same model reply in both languages. |
