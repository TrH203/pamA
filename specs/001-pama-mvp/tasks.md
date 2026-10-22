---
description: "Task list for pamA MVP v0.1"
---

# Tasks: pamA MVP v0.1 (Please Ask my AI)

**Input**: Design documents from `/specs/001-pama-mvp/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included. Constitution V (NON-NEGOTIABLE) requires tests **before** implementation for
redaction rules, policy/scope resolution and the answer guard, plus the red-team eval suite
(FR-032). Contract tests for shared schemas are required by the constitution workflow. Test tasks
in each story come first and MUST fail before the matching implementation task starts.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested
independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: User story the task belongs to (US1–US5)
- Every task names the exact file path(s)

## Path Conventions

Monorepo per plan.md: Rust in `crates/`, TypeScript in `apps/` and `packages/`, shared assets in
`rules/`, `prompts/`, `evals/`, deployment in `deploy/`, docs in `docs/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo initialization, tooling, CI and licensing gates

- [X] T001 Create the top-level layout from plan.md (`crates/`, `apps/`, `packages/`, `rules/`, `prompts/`, `evals/`, `deploy/`, `docs/`) with `README.md`, `LICENSE` (Apache-2.0) and `NOTICE` at the repo root
- [X] T002 Create the Cargo workspace in `Cargo.toml` (members `crates/pama-core`, `crates/pama-cli`, `crates/pama-desktop/src-tauri`; edition 2021) and `rust-toolchain.toml` (stable, MSRV 1.85)
- [X] T003 Create the pnpm workspace: `pnpm-workspace.yaml`, root `package.json` (scripts `test`, `typecheck`, `lint`, `evals`), `.nvmrc` (24), `tsconfig.base.json` (strict)
- [X] T004 [P] Scaffold `crates/pama-core` library (`crates/pama-core/Cargo.toml` with serde, serde_json, regex, rusqlite, reqwest, typeshare 1.0, thiserror; `crates/pama-core/src/lib.rs`)
- [X] T005 [P] Scaffold `crates/pama-cli` binary with a clap command tree matching contracts/cli.md (`init`, `hook`, `scan`, `review`, `link`, `inbox`, `reply`, `log`, `sync`, `pair`, `server`, `doctor`, `config`), global flags `--json`, `--server`, `-v` and exit codes 0–4, in `crates/pama-cli/src/main.rs`
- [X] T006 [P] Scaffold `apps/server` (hono, @hono/node-server, drizzle-orm, zod 4, ai v7, vitest) with `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/index.ts`
- [X] T007 [P] Scaffold `apps/web` (React 19, Vite, Tailwind, vitest, Playwright) with entries for the Ask Link page, owner console and desktop popup in `apps/web/src/{ask,console,desktop}/main.tsx`
- [X] T008 [P] Scaffold `packages/types` (generated types + schema) and `packages/ui` (shared React components) with their `package.json` files
- [X] T009 [P] Configure formatting and linting: `rustfmt.toml`, `clippy.toml`, `biome.json`
- [X] T010 [P] Configure CI in `.github/workflows/ci.yml`: `cargo test --workspace`, `cargo fmt --check`, `cargo clippy --workspace -- -D warnings` on macOS + Windows + Linux; `pnpm -r lint` (biome), `pnpm -r typecheck`, `pnpm -r test` with a `pgvector/pgvector:pg16` service container
- [X] T011 [P] Add license gates: `deny.toml` (cargo-deny, deny GPL/AGPL/LGPL) and `scripts/check-licenses.mjs` (npm deps), both run in `.github/workflows/ci.yml`
- [X] T012 [P] Add `CONTRIBUTING.md`, `SECURITY.md` and `.github/PULL_REQUEST_TEMPLATE.md` with the constitution check list (principles I–VI)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared schema, shared redaction rules, server core, device core and the eval harness.
The R3/R4/R6 spikes run here because they decide adapter details used by every story.

**⚠️ CRITICAL**: No user story work starts until this phase is complete

### Shared digest contract

- [X] T013 Copy `specs/001-pama-mvp/contracts/session-digest.schema.json` to `packages/types/schema/session-digest.schema.json` (single source of truth; CI step in `.github/workflows/ci.yml` fails if the two copies differ) and add valid/invalid fixtures in `packages/types/fixtures/digest-*.json` (unknown field, `goal` over 1000 chars, `decisions` over 30 items, commit not matching `^[0-9a-f]{7,40}$`, missing `redactions`)
- [X] T014 [P] Write contract test (must fail first) `crates/pama-core/tests/contract_digest_schema.rs`: serde `SessionDigest` round-trips every valid fixture, rejects every invalid one, and its output validates against the JSON Schema (jsonschema crate)
- [X] T015 [P] Write contract test (must fail first) `apps/server/tests/contract/digest-schema.test.ts`: the Zod schema and Ajv (JSON Schema 2020-12) give the same accept/reject result for every fixture
- [X] T016 Define `SessionDigest`, `Decision`, `Redactions`, `SourceRef` in `crates/pama-core/src/digest.rs` with `#[typeshare]` and `#[serde(deny_unknown_fields)]`, enforcing the schema limits ("`additionalProperties: false`", `schema_version` const 1, `agent` ∈ `claude_code | codex`, labels ∈ `business_sensitive | infra | customer`)
- [X] T017 Add `scripts/gen-types.sh` (typeshare-cli 1.13 → `packages/types/src/generated.ts`) and a CI step in `.github/workflows/ci.yml` that fails when the generated file differs
- [X] T018 Implement the Zod schema mirroring the JSON Schema in `apps/server/src/schema/digest.ts` (strict objects, same max lengths)

### Shared redaction rules (Layer 1 + rule part of Layer 3) — VERIFY R3

- [X] T019 Vendor gitleaks' default config into `rules/gitleaks.toml` with `rules/LICENSE-gitleaks` and `scripts/update-gitleaks-rules.sh` (pinned upstream tag, no local edits)
- [X] T020 [P] Write `rules/pama.toml` per contracts/redaction-rules.md: structural rules `dotenv-file-read` (`**/.env`, `**/.env.*`, `**/*.pem`, `**/id_rsa*`, `**/id_ed25519*` → `drop_content`) and `env-dump` (`^\s*(env|printenv|set)\s*$`), connection strings, JWTs, and `category = "pii"` rules for email, phone, Vietnamese CCCD and bank accounts
- [X] T021 [P] Build the rule corpus `rules/tests/positives/*.txt` and `rules/tests/negatives/*.txt` (at least one positive per `pama.toml` rule plus gitleaks' own test vectors for parity, including `AKIAIOSFODNN7EXAMPLE` as an allowlisted negative)
- [X] T022 Write the Rust rule test (must fail first) `crates/pama-core/tests/redaction_rules.rs`: every rule compiles with ASCII semantics, every positive is replaced with `[SECRET:<id>]` or `[PII:<id>]`, every negative is untouched, and `by_rule` counts are correct
- [X] T023 [P] Write the TS rule test (must fail first) `apps/server/tests/unit/rules.test.ts`: same corpus, same output as Rust, and a JS compile report with zero untranslated rules from `pama.toml`
- [X] T024 Implement the Rust rule loader and redactor in `crates/pama-core/src/redact/{rules.rs,engine.rs,entropy.rs}`: `RegexBuilder::unicode(false)`, raised `size_limit`, `keywords` prefilter, Shannon `entropy` floor, `secretGroup`, `allowlists`, per-rule counts
- [X] T025 Implement the TS rule loader in `apps/server/src/safety/rules.ts`: RE2 → JS translation (`(?i)` → `i` flag, `\z` → `$` without `m`), a compile report listing untranslated rules, and the same placeholder format

### Spikes (decide adapter details)

- [X] T026 Spike R4 in `apps/server/spikes/pglite-hnsw-rls.test.ts`: `CREATE INDEX ... USING hnsw` with pglite-pgvector on PGlite 0.5, and RLS under a non-superuser role with `SET ROLE` per transaction; record the outcome in `specs/001-pama-mvp/research.md` § R4
- [X] T027 Spike R6 in `scripts/spike-bun-compile.sh`: `bun build --compile` a minimal Hono + PGlite server for `bun-darwin-arm64` with embedded `.wasm`/`.data` assets, check initdb (try `BUN_JSC_useWasmIPInt=false`); record the outcome and fallback decision (Node SEA) in `specs/001-pama-mvp/research.md` § R6

### Server core

- [X] T028 Implement config in `apps/server/src/config.ts` (zod-validated env: `PAMA_MODE` ∈ `local | selfhost | cloud`, database URL or PGlite data dir, bind address default `127.0.0.1`, provider settings, SMTP, base URL)
- [X] T029 Implement the `Db` adapter in `apps/server/src/db/client.ts` (node-postgres + pgvector, or PGlite + pglite-pgvector persisted to the data dir), selected by mode
- [X] T030 Set up migrations: `apps/server/drizzle.config.ts` and a runner in `apps/server/src/db/migrate.ts` that applies the same SQL on pg and PGlite
- [X] T031 Define the foundational tables in `apps/server/src/db/schema/core.ts`: `workspaces` (`default_deny_labels` ⊆ `business_sensitive, infra, customer`; `auto_approve` default false; `embed_model` default `bge-m3`, `embed_dim` default 1024; `answer_threshold` default 0.7 cloud / 0.8 local), `network_log` (`component` ∈ `server | desktop | cli`, `host`, `purpose`, `allowed`), `jobs` (`status` ∈ `queued | running | done | failed`); ULID text ids, `timestamptz` UTC; on first start in `local` mode create the single default workspace (`owner_email` null) in `apps/server/src/services/bootstrap-local.ts`
- [X] T032 [P] Write the queue test (must fail first) `apps/server/tests/integration/queue.test.ts`: send/work/schedule and retry behave the same on both adapters
- [X] T033 Implement `JobQueue` in `apps/server/src/queue/{index.ts,pgboss.ts,inprocess.ts}` (pg-boss 12 for server modes; in-process worker polling `jobs` on PGlite)
- [X] T034 [P] Write the egress test (must fail first) `apps/server/tests/unit/egress.test.ts`: every outbound request is logged in `network_log` with host and purpose; undeclared hosts are blocked when strict mode is on
- [X] T035 Implement the egress guard in `apps/server/src/net/egress.ts` (undici global dispatcher, declared-host allowlist, `network_log` writes, strict flag)
- [X] T036 Implement the model provider registry in `apps/server/src/llm/providers.ts` (AI SDK v7: `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, `ollama-ai-provider-v2`; per-workspace chat and embedding models; all traffic through the egress guard) and a deterministic fake provider in `apps/server/src/llm/fake.ts` for tests
- [X] T037 Implement versioned prompt loading in `apps/server/src/llm/prompts.ts` (reads `prompts/*.md` with a `version` front-matter field; the version is stored as provenance) and document the format in `prompts/README.md`
- [X] T038 Implement the Hono app in `apps/server/src/app.ts`: error body `{ "error": { "code", "message" } }`, request ids, `GET /v1/health` → `{status, mode, db, version}`, route mounting
- [X] T039 Implement local-mode owner auth in `apps/server/src/auth/local-token.ts` (per-launch token, only on `127.0.0.1`)
- [X] T040 [P] Add test helpers `apps/server/tests/helpers/db.ts` (in-memory PGlite + Postgres container, run every integration test on both) and `apps/server/tests/fixtures/seed.ts` (approved digests in two projects, A and B, with labelled items) so US2 can be tested without US1

### Device core (Rust)

- [X] T041 Implement the device store in `crates/pama-core/src/store/{mod.rs,schema.sql}` (SQLite): `captured_session` (`agent` ∈ `claude_code | codex`, `agent_session_id` unique per agent, `transcript_path` never sent, `transcript_sha256`, status machine `detected → redacting → digesting → ready_for_review → submitted`, `failed`, `skipped`), `outbox_item` (`kind` ∈ `digest_upsert | source_tombstone | bundle_change`, `status` ∈ `pending | sent | dead`, ULID idempotency key), `settings` key/value
- [X] T042 [P] Implement the Rust egress guard and HTTP client in `crates/pama-core/src/net.rs` (reqwest wrapper, declared hosts, strict flag, appends to a local network log)
- [X] T043 [P] Implement OS keychain storage in `crates/pama-core/src/secrets.rs` (keyring-core 1.0 with apple/windows native stores) for device tokens and provider API keys

### Eval harness

- [X] T044 Implement the eval runner in `evals/runner.ts` with the case format documented in `evals/README.md` (YAML: link settings, question, expected outcome, forbidden strings), fixture digests in `evals/fixtures/`, root script `pnpm evals` that exits non-zero on any leak

**Checkpoint**: shared contracts, rules, server and device cores ready; user stories can start

---

## Phase 3: User Story 1 - Capture sessions and review digests (Priority: P1) 🎯 MVP

**Goal**: an ended Claude Code or Codex session becomes a secret-free English draft digest in the
review queue, grouped into a bundle; the owner approves, edits or discards it.

**Independent Test**: quickstart.md Scenario 1. Run a session that reads `fixtures/.env.sample`
(fake `AKIA…` key) and makes a decision; within 2 minutes `pama review --json` shows a draft that
validates against the schema, contains no `AKIA`, has `redactions.secret ≥ 1` and lists the
decision with `why`; a second session on the same branch joins the same bundle.

### Tests for User Story 1 (write first, must fail) ⚠️

- [X] T045 [P] [US1] Add anonymized Claude Code transcript fixtures per version in `crates/pama-core/tests/fixtures/claude/*.jsonl` (main + `subagents/agent-<id>.jsonl`, unknown record types, a `.env` read with a fake AKIA key, `env` command output)
- [X] T046 [P] [US1] Add Codex rollout fixtures in `crates/pama-core/tests/fixtures/codex/*.jsonl` (`session_meta` with `cwd`/`git.branch`, encrypted `reasoning`, `function_call(_output)`, `event_msg task_complete`)
- [X] T047 [P] [US1] Write the Claude adapter test `crates/pama-core/tests/adapter_claude.rs`: normalized events, unknown record types ignored, `cwd`/`gitBranch`/`sessionId` extracted, subagent transcripts merged
- [X] T048 [P] [US1] Write the Codex adapter test `crates/pama-core/tests/adapter_codex.rs`: normalized events, encrypted reasoning skipped, project and branch taken from `session_meta`
- [X] T049 [P] [US1] Write the event redaction test `crates/pama-core/tests/redact_events.rs`: `.env`/`*.pem` read content dropped, `env`/`printenv` output dropped, no `AKIA` string remains in any event, counts reported by type
- [X] T050 [P] [US1] Write the digest pipeline test `apps/server/tests/integration/digest-pipeline.test.ts` (fake LLM): output validates against the schema, Layer-2 PII rules applied, labels assigned, sessions grouped by branch into one bundle, status `draft`, re-submitting the same content is idempotent on `digest_hash`
- [X] T051 [P] [US1] Write the review test `apps/server/tests/integration/review.test.ts`: approve; approve with edited content creates version+1 and supersedes the old version; discard; withdraw deactivates items; project `auto_approve` overrides workspace; unapproved items are never retrievable; bundle rename/split/merge (FR-005)
- [X] T052 [P] [US1] Write the local-only test `apps/server/tests/integration/transcripts-local-only.test.ts`: `POST /v1/transcripts/digest` returns 403 when `PAMA_MODE` is `selfhost` or `cloud`

### Implementation for User Story 1 — device (Rust)

- [X] T053 [US1] Define the normalized event model in `crates/pama-core/src/session/event.rs` (user text, assistant text, tool call with tool/path/command, tool result, metadata)
- [X] T054 [P] [US1] Implement the Claude Code adapter in `crates/pama-core/src/session/claude.rs` (path `~/.claude/projects/<cwd with "/"→"-">/<sessionId>.jsonl`, subagents, tolerant parsing)
- [X] T055 [P] [US1] Implement the Codex adapter in `crates/pama-core/src/session/codex.rs` (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, envelope `{timestamp, type, payload}`)
- [X] T056 [US1] Implement structural rules over events in `crates/pama-core/src/redact/structural.rs` (`drop_content`, `redact_all`) and apply the regex engine to every text field
- [X] T057 [US1] Implement a streaming transcript reader in `crates/pama-core/src/session/reader.rs` (bounded memory for files of hundreds of MB, malformed lines skipped, oversize → `failed` with reason) and a benchmark in `crates/pama-core/benches/redact.rs` (target ≥ 20 MB/s parse + Layer 1)
- [X] T058 [US1] Implement project key normalization in `crates/pama-core/src/project.rs` (normalized remote URL, else path hash; never an absolute local path) and bundle key from git branch
- [X] T059 [US1] Implement the capture worker in `crates/pama-core/src/capture/worker.rs`: drives the `captured_session` state machine, retries with backoff (max 5), sends Layer-1-redacted events to the local sidecar `POST /v1/transcripts/digest`
- [X] T060 [US1] Implement `pama config set|get` in `crates/pama-cli/src/cmd/config.rs` for `provider.*` (API keys go to the OS keychain) and `hotkey.answer_source`, and pass provider settings to the local server (FR-031)
- [X] T061 [US1] Implement `pama hook claude` and `pama hook codex` in `crates/pama-cli/src/cmd/hook.rs`: read stdin JSON (or argv JSON for Codex `notify`), enqueue `{session_id, transcript_path, cwd, reason}`, exit in < 200 ms (asserted in `crates/pama-cli/tests/hook_latency.rs`), never parse the transcript inline
- [X] T062 [US1] Implement `pama init` in `crates/pama-cli/src/cmd/init.rs`: write `SessionEnd` + `Stop` hooks into `.claude/settings.local.json` (or user scope with `--global`), register Codex hooks in `~/.codex/hooks.json` or `notify`, idempotent, print what changed, never edit committed settings without `--project-scope`
- [X] T063 [US1] Implement the watcher fallback in `crates/pama-core/src/capture/watcher.rs` (notify 8.2 + debouncer-full 0.7, idle ≥ 2 min) and `pama scan [--since]` in `crates/pama-cli/src/cmd/scan.rs`
- [X] T064 [US1] VERIFY R2: test Codex hooks and `notify` on the currently released Codex CLI versions and record the support matrix in `docs/agents.md` (watcher fallback stays mandatory)
- [X] T065 [US1] Implement `pama server start|stop|status` in `crates/pama-cli/src/cmd/server.rs` (spawns the local server bound to `127.0.0.1`, `--lan` opt-in) so US1 works without the desktop app

### Implementation for User Story 1 — server (TypeScript)

- [X] T066 [US1] Define tables in `apps/server/src/db/schema/digest.ts` + migration: `projects` (`auto_approve` nullable override, `sync_enabled` default false), `bundles` (`key` = branch, `sync_enabled` nullable inherits), `sessions` (unique `(workspace_id, agent, agent_session_id)`, `redaction_counts` `{secret, pii}`), `digests` (versioned immutable rows, `version` starts at 1, `digest_hash` unique per session, status `draft | approved | superseded | discarded | withdrawn`, `prompt_version`, `model`), `digest_items` (`kind` ∈ `goal | decision | outcome | open_item | module`, `text` ≤ 1,000 chars, `labels`, `embedding vector(embed_dim)` with HNSW cosine index, `tsv`, `active`)
- [X] T067 [P] [US1] Write the digest prompt `prompts/digest.md` (English output, key ideas and decisions only, transcript wrapped as data, embedded instructions never followed)
- [X] T068 [P] [US1] Implement Layer 2 in `apps/server/src/pipeline/classify.ts` with `prompts/classify.md` (PII rules from `rules/pama.toml` + LLM labels `business_sensitive | infra | customer`)
- [X] T069 [US1] Implement the digest job in `apps/server/src/pipeline/digest.ts`: events → `generateText` with `Output.object` (Zod digest schema) → Layer-1 rule re-scan → Layer 2 → persist draft and items; embed items in `apps/server/src/pipeline/embed.ts`
- [X] T070 [US1] Implement bundles in `apps/server/src/services/bundles.ts` (auto-assign by branch, rename, split, merge)
- [X] T071 [US1] Implement digest lifecycle in `apps/server/src/services/digests.ts` (approve/edit → new version, only the latest approved version has `active` items, discard, withdraw, auto-approve resolution project → workspace; withdrawing or deleting a source whose sync is on queues a tombstone for every replica (Constitution I, FR-025); a guard rule hit on an approved item withdraws the digest and raises a `review://new` alert)
- [X] T072 [US1] Implement `POST /v1/transcripts/digest` in `apps/server/src/routes/device.ts` (local mode only, else 403; 422 on invalid input)
- [X] T073 [US1] Implement owner routes in `apps/server/src/routes/review.ts`: `GET /v1/review`, `POST /v1/digests/{id}/approve|discard|withdraw`, `GET/PATCH /v1/projects/{id}` (`auto_approve`), `GET/PATCH /v1/bundles/{id}`, `POST /v1/bundles/{id}/split`, `POST /v1/bundles/merge`
- [X] T074 [US1] Implement `pama review` in `crates/pama-cli/src/cmd/review.rs` (list drafts, `--approve`, `--discard`, `--edit` via `$EDITOR` on the digest JSON, `--json`)
- [X] T075 [US1] Build the review page in `apps/web/src/console/Review.tsx` (draft list, edit, approve/discard, auto-approve toggle, bundle rename/split/merge)
- [X] T076 [US1] Add the end-to-end test for quickstart Scenario 1 in `apps/server/tests/e2e/us1-capture.test.ts` (fixture transcript → hook → draft in review queue, no `AKIA`, bundle grouping)

**Checkpoint**: US1 works alone as a private "what did I decide and why" log

---

## Phase 4: User Story 2 - Share an Ask Link and let askers self-serve (Priority: P1)

**Goal**: the owner creates a scoped, access-controlled link with suggested sources and
questions; askers get cited answers in their language, or refusals they can forward to the owner's
inbox; everything is audited.

**Independent Test**: quickstart.md Scenario 2 with seeded approved digests
(`apps/server/tests/fixtures/seed.ts`): PIN link over one bundle; a Vietnamese in-scope question
is answered in Vietnamese with citations; a question about another project and a request for a
credential are refused and can be forwarded; 5 wrong PINs → 423; a revoked link → 410.

### Tests for User Story 2 (write first, must fail) ⚠️

- [X] T077 [P] [US2] Write the scoped repository test `apps/server/tests/integration/scoped-repo.test.ts` (pg + PGlite): never returns items outside `allowed_session_ids`, items with denied labels, or inactive items; on pg the RLS policy also blocks a raw query that skips the filter
- [X] T078 [P] [US2] Write the policy test `apps/server/tests/unit/resolve-link.test.ts`: expired/revoked → 410, `degraded` serves remaining sources, `deny_labels` ⊇ workspace defaults, source refs resolve to session ids at query time
- [X] T079 [P] [US2] Write the access test `apps/server/tests/integration/access.test.ts`: argon2id PIN; 5 failed attempts → 423 for 15 minutes (per visitor + IP); OTP 6 digits, 10-minute TTL, 5 attempts; allowlist emails and `*@domain`; cookie scoped to `/a/<slug>`; rate limit `rate_limit_per_hour` (1–500, default 30) → 429
- [X] T080 [P] [US2] Write the guard test `apps/server/tests/unit/guard.test.ts`: a rule hit, `leak`, `off_scope` or `unsupported_claims` from the judge ⇒ `refused`; an `answered` ask without ≥ 1 citation is rejected; refusal reasons ∈ `out_of_scope | low_confidence | denied_topic | guard_failed`
- [X] T081 [P] [US2] Write the public API contract test `apps/server/tests/contract/public-api.test.ts`: response shapes per contracts/http-api.md, `X-Pama-Automated: true`, 410 bodies contain only the error code, no project or bundle names outside the link appear in any response
- [X] T082 [P] [US2] Write ≥ 50 red-team cases in `evals/cases/*.yaml` with fixture digests in `evals/fixtures/`: secret extraction, cross-scope probing, prompt injection in the question and inside digest text, hallucinated decisions, language switching (Vietnamese/English)

### Implementation for User Story 2

- [X] T083 [US2] Define tables in `apps/server/src/db/schema/links.ts` + migration: `ask_links` (`slug` PK 8+ chars base32 unguessable, `source_refs` jsonb `{type: project|bundle|session, id}`, `detail` ∈ `headline | summary | technical` default `summary`, `deny_labels`, `deny_topics`, `instruction` ≤ 2,000 chars, `access_mode` ∈ `open | pin | email_otp | allowlist` default `pin`, `pin_hash` required iff `pin`, `allowlist` required iff `allowlist`, `rate_limit_per_hour` default 30 range 1–500, `expires_at` default now+7d max 90d, `revoked_at`, `footer_enabled` default true), `suggested_questions` (`text` ≤ 200 chars, `rank`, `edited_by_owner`), `visitors` (`email` nullable, `verified_at`, `ip_hash`, `failed_attempts`, `locked_until`), `asks` (`origin` ∈ `link | hotkey`, `question` ≤ 2,000 chars, `language` BCP-47, status `received | answered | refused | forwarded | owner_answered | dismissed | drafted`, `citations` `[{item_id, digest_id, digest_version}]`, `confidence`, `guard` `{leak, off_scope, unsupported_claims, rule_hits[]}`, `owner_reply`)
- [X] T084 [US2] Implement the scoped repository in `apps/server/src/policy/scoped-repo.ts` (always `session_id = ANY($1) AND active AND NOT labels && $2`) and RLS policies in `apps/server/src/db/rls.sql` reading `current_setting('pama.allowed_session_ids')` under a non-superuser application role created by migration `apps/server/src/db/roles.sql` (PGlite only if the R4 spike passed)
- [X] T085 [US2] Implement `resolveLink(slug, visitor)` in `apps/server/src/policy/resolve-link.ts` → `{allowed_session_ids, deny_labels, deny_topics, detail, instruction}`
- [X] T086 [US2] Implement hybrid retrieval in `apps/server/src/pipeline/retrieve.ts` (pgvector cosine + Postgres full-text over scoped items only, top-k 8)
- [X] T087 [US2] Implement source suggestions in `apps/server/src/pipeline/suggest.ts` and `POST /v1/suggest` (ranked by relevance and recency; sources with flagged labels returned with `preselected: false`)
- [X] T088 [P] [US2] Implement suggested questions (3–5 per link, editable) in `apps/server/src/pipeline/suggest-questions.ts` with `prompts/suggest-questions.md`
- [X] T089 [US2] Implement answering in `apps/server/src/pipeline/answer.ts` with `prompts/answer.md`: order system policy → owner instruction → retrieved items as data → question as data; output `{status, answer, citations[], confidence}`; answer in the asker's language; follow `detail`; refuse below the workspace threshold (0.7 cloud / 0.8 local)
- [X] T090 [US2] Implement Layer 3 in `apps/server/src/pipeline/guard.ts` with `prompts/judge.md` (TS rule re-scan with `rules/` + PII + deny topics + LLM judge `{leak, off_scope, unsupported_claims}`; any failure ⇒ refused)
- [X] T091 [US2] Implement link routes in `apps/server/src/routes/links.ts`: `POST /v1/links` (rejects sources not approved or not owned; PIN accepted in clear only in the request; returns `{slug, url, suggested_questions[]}`), `GET /v1/links`, `GET/PATCH /v1/links/{slug}`, `POST /v1/links/{slug}/revoke` → 204
- [X] T092 [US2] Implement access control in `apps/server/src/policy/access.ts` and `POST /a/{slug}/api/access` (PIN, OTP send/verify, allowlist, lockout, signed httpOnly cookie)
- [X] T093 [P] [US2] Implement email in `apps/server/src/mail/index.ts` (nodemailer SMTP; without SMTP only `open` and `pin` modes can be selected)
- [X] T094 [P] [US2] Implement rate limiting in `apps/server/src/policy/rate-limit.ts` (per link per hour, per visitor)
- [X] T095 [US2] Implement public routes in `apps/server/src/routes/public.ts`: `GET /a/{slug}/api/meta`, `POST /a/{slug}/api/ask`, `POST /a/{slug}/api/asks/{ask_id}/forward` (409 if already forwarded), `GET /a/{slug}/api/asks`; every call writes an `asks`/`visitors` audit row and sets `X-Pama-Automated: true`
- [X] T096 [US2] Implement inbox and audit routes in `apps/server/src/routes/inbox.ts`: `GET /v1/inbox`, `POST /v1/asks/{id}/reply` (shown on the link page, emailed if the visitor verified), `POST /v1/asks/{id}/dismiss`, `GET /v1/audit` with filters and `?format=csv`
- [X] T097 [P] [US2] Implement audit retention in `apps/server/src/jobs/retention.ts` (default 180 days, configurable; owner export/delete)
- [X] T098 [US2] Serve the web builds from the server in `apps/server/src/routes/static.ts` (`GET /a/{slug}` SPA, 410 page without content for expired/revoked, owner console)
- [X] T099 [US2] Build the Ask Link page in `apps/web/src/ask/{AskPage.tsx,AccessGate.tsx,Thread.tsx}`: owner name, coverage, suggested questions, "automated answer on behalf of <owner>" label, citations, forward button, owner replies, "link no longer active" and "owner's agent is offline" states (shown when an already-open page loses the server), and a post-answer useful/not useful rating stored on the ask (SC-006)
- [X] T100 [US2] Build the console in `apps/web/src/console/{LinkCreate.tsx,Links.tsx,Inbox.tsx,Audit.tsx}`: query → ranked suggestions with flagged sources unchecked, defaults (7 days, summary, PIN, 30/hour), edit suggested questions, revoke, inbox reply, audit filters and CSV export
- [X] T101 [US2] Implement `pama link create|list|revoke`, `pama inbox`, `pama reply`, `pama log` in `crates/pama-cli/src/cmd/{link.rs,inbox.rs,log.rs}` per contracts/cli.md
- [X] T102 [US2] Wire `evals/runner.ts` to the real answer pipeline and add `.github/workflows/evals.yml` that runs `pnpm evals` on every PR touching `prompts/`, `rules/`, `apps/server/src/pipeline/` or `apps/server/src/policy/` (zero-leak gate)
- [X] T103 [US2] Add the Playwright test for quickstart Scenario 2 in `apps/web/tests/e2e/ask-link.spec.ts`

**Checkpoint**: US1 + US2 = the core product, demoable in local mode over LAN

---

## Phase 5: User Story 3 - Answer from anywhere with a hotkey (Priority: P2)

**Goal**: on macOS and Windows, select a question in any app, press the hotkey, get a cited draft
in a popup, paste or copy it; nothing is ever sent and the clipboard is restored.

**Independent Test**: quickstart.md Scenario 3 on each OS in two apps: popup within 3 s, Paste
inserts without sending, the clipboard sentinel is restored, empty selection opens an empty box.

### Tests for User Story 3 (write first, must fail) ⚠️

- [X] T104 [P] [US3] Write clipboard tests in `crates/pama-desktop/src-tauri/tests/clipboard.rs` (mock clipboard trait): snapshot and restore after capture, restore 500 ms after paste, clipboard untouched when the popup closes without Copy, no captured text persisted besides the question
- [X] T105 [P] [US3] Write the draft API test `apps/server/tests/integration/draft.test.ts`: `POST /v1/draft` returns `answered` with citations or `refused` with a reason, `shorter: true` shortens, `suggested_scope` returned, an `asks` row with `origin = hotkey` and status `drafted` is written

### Implementation for User Story 3

- [X] T106 [US3] Scaffold the Tauri 2.12 app in `crates/pama-desktop/src-tauri/` (`tauri.conf.json`, `capabilities/default.json` with least privilege, plugins global-shortcut, clipboard-manager, shell, positioner, autostart, notification; updater present but disabled by default)
- [X] T107 [US3] Add `scripts/build-sidecar.sh` (`bun build --compile` for `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64` with embedded PGlite assets → `crates/pama-desktop/src-tauri/binaries/pama-server-<target-triple>`), or the Node SEA fallback if the R6 spike failed
- [X] T108 [US3] Implement sidecar management in `crates/pama-desktop/src-tauri/src/sidecar.rs` (spawn via `bundle.externalBin`, per-launch token, port discovery, health check, restart; `sidecar_status` command; `sidecar://state` event)
- [X] T109 [P] [US3] Implement tray, autostart and notifications (`inbox://new`, `review://new`) in `crates/pama-desktop/src-tauri/src/tray.rs`
- [X] T110 [P] [US3] Implement accessibility capture in `crates/pama-desktop/src-tauri/src/capture/macos.rs` (AX selected text) and `crates/pama-desktop/src-tauri/src/capture/windows.rs` (UI Automation)
- [X] T111 [US3] Implement the clipboard fallback in `crates/pama-desktop/src-tauri/src/capture/clipboard.rs` (arboard 3.7 snapshot of text/HTML/image/files, enigo 0.6 copy keystroke, poll `NSPasteboard.changeCount` / `GetClipboardSequenceNumber` every 10 ms up to 300 ms, restore) and the `capture_selection` command returning `{text, method, app}`
- [X] T112 [US3] Implement `paste_draft` and `copy_draft` in `crates/pama-desktop/src-tauri/src/commands/draft.rs` (paste into the previously focused app, never press Enter, restore clipboard after 500 ms); add no command that sends messages
- [X] T113 [US3] Implement the hotkey and permissions in `crates/pama-desktop/src-tauri/src/hotkey.rs` (`set_hotkey` with conflict detection, `get_permissions`, `open_permission_settings`, `hotkey://triggered` with cursor position, popup placed at the cursor)
- [X] T114 [US3] Implement `POST /v1/draft` in `apps/server/src/routes/draft.ts` reusing the retrieval, answer and guard pipeline over the owner's approved items
- [X] T115 [P] [US3] Implement typed IPC and API wrappers in `apps/web/src/desktop/{ipc.ts,api.ts}` per contracts/desktop-ipc.md, including `answer_source` ∈ `local | server | auto` (FR-029)
- [X] T116 [US3] Build the popup in `apps/web/src/desktop/Popup.tsx`: Copy, Paste, Shorter, Edit, Change scope, Create Ask Link (opens LinkCreate pre-filled with the question and suggested sources); empty question box when capture method is `none`
- [X] T117 [US3] Write the manual test matrix for quickstart Scenario 3 in `docs/testing/hotkey-matrix.md` (macOS + Windows × Zalo, Slack, Teams, Chrome, Outlook; Accessibility prompt; UIPI limits)

**Checkpoint**: owner can answer in any chat app without the asker opening a link

---

## Phase 6: User Story 4 - Run fully local and control sync (Priority: P2)

**Goal**: everything works offline with local models; approved digests sync only for sources the
owner enabled, exactly once; disabling sync removes remote copies; strict offline mode blocks
undeclared hosts and logs every connection.

**Independent Test**: quickstart.md Scenario 4: offline run of Scenarios 1–3 with Ollama, the
network log shows only declared hosts; enable sync for one bundle → appears once on the server;
disable → server items deleted and the link stops serving them.

### Tests for User Story 4 (write first, must fail) ⚠️

- [ ] T118 [P] [US4] Write the sync API test `apps/server/tests/integration/sync.test.ts`: only approved digests accepted, 409 when sync is disabled for the source, idempotent on `outbox_id` and `digest_hash`, tombstone deletes digests and items and marks links `degraded`, revoked device → 401
- [ ] T119 [P] [US4] Write the outbox test `crates/pama-core/tests/outbox.rs`: exactly-once delivery across simulated offline periods, exponential backoff, `dead` after max attempts
- [ ] T120 [P] [US4] Write strict offline tests `crates/pama-core/tests/net_guard.rs` and `apps/server/tests/unit/egress-strict.test.ts`: undeclared host blocked and logged with `allowed = false`, declared hosts allowed

### Implementation for User Story 4

- [ ] T121 [US4] Add `GET /v1/sync/pending` (local sidecar only: approved digests of sync-enabled sources not yet delivered, plus pending tombstones) to `specs/001-pama-mvp/contracts/http-api.md` and implement it in `apps/server/src/routes/sync-local.ts`
- [ ] T122 [US4] Define tables in `apps/server/src/db/schema/sync.ts` + migration: `devices` (`token_hash` argon2id, `last_seen_at`, `revoked_at`), `sync_tombstones` (`source_type`, `source_id`, `received_at`)
- [ ] T123 [US4] Implement pairing in `apps/server/src/routes/devices.ts` (`POST /v1/devices/pair`, one-time code shown in console, 410 when expired, device revoke) and device bearer auth in `apps/server/src/auth/device.ts`
- [ ] T124 [US4] Implement `POST /v1/sync/digests` and `POST /v1/sync/tombstones` in `apps/server/src/routes/sync.ts` (tombstone → delete items, `active = false`, affected links `degraded`)
- [ ] T125 [US4] Implement the device sync worker in `crates/pama-core/src/sync/{mod.rs,outbox.rs}`: poll `GET /v1/sync/pending` on the sidecar, write `outbox_item` rows, deliver to the target with idempotency keys and backoff
- [ ] T126 [US4] Implement `pama pair` in `crates/pama-cli/src/cmd/pair.rs` (token stored in the OS keychain) and `pama sync status|enable|disable` in `crates/pama-cli/src/cmd/sync.rs` (default off; disable issues tombstones)
- [ ] T127 [US4] Implement strict offline wiring: `strict_offline` and `declared_hosts` keys in `crates/pama-cli/src/cmd/config.rs`, desktop commands `set_sync`, `set_strict_offline`, `get_network_log` in `crates/pama-desktop/src-tauri/src/commands/settings.rs`, and `GET /v1/network-log` in `apps/server/src/routes/network-log.ts`
- [ ] T128 [US4] Build the settings view in `apps/web/src/desktop/Settings.tsx` (per-source sync toggles, strict offline, declared hosts, network log, model providers, hotkey, answer source)
- [ ] T129 [P] [US4] Document local-mode link exposure in `docs/local-links.md` (LAN binding, Tailscale Funnel, Cloudflare Tunnel with the TLS warning; Ollama is outside the egress guard)
- [ ] T130 [US4] Add the end-to-end test for quickstart Scenario 4 in `apps/server/tests/e2e/us4-sync.test.ts` (local PGlite sidecar + remote Postgres server, enable/disable sync, network log assertions)

**Checkpoint**: privacy story complete; data leaves the machine only by explicit per-source choice

---

## Phase 7: User Story 5 - Self-host the server (Priority: P3)

**Goal**: a team runs the server with one documented docker compose procedure; pamA Cloud runs
the same image.

**Independent Test**: quickstart.md Scenario 5: clean host → ready in < 15 minutes; pair a device,
sync one bundle, turn the owner's machine off, answer through a link served by this server.

- [ ] T131 [P] [US5] Write `deploy/Dockerfile` (multi-stage, Node 24, non-root user, includes the web build, `PAMA_MODE` default `selfhost`)
- [ ] T132 [P] [US5] Write `deploy/docker-compose.yml` (server + `pgvector/pgvector:pg16`, healthchecks, volumes) and `deploy/.env.example` (base URL, SMTP, model provider, secrets)
- [ ] T133 [US5] Configure the compose database user for the non-superuser application role from `apps/server/src/db/roles.sql` in `deploy/initdb/01-roles.sql`
- [ ] T134 [US5] Implement owner email magic-link sign-in in `apps/server/src/auth/magic-link.ts` and `apps/web/src/console/Login.tsx` (server modes only)
- [ ] T135 [US5] Implement first-run workspace bootstrap in `apps/server/src/services/bootstrap.ts` (first owner email, one owner per workspace; `cloud` mode allows many workspaces with the same code)
- [ ] T136 [US5] Write the self-host guide `docs/self-host.md` (≤ 15 minutes, SMTP, TLS via reverse proxy example, backups, upgrades)
- [ ] T137 [US5] Add `.github/workflows/docker.yml`: build the image, `docker compose up`, assert `GET /v1/health` returns `mode: selfhost, db: pg`, run the US2 contract tests against it

**Checkpoint**: always-on links without the owner's laptop

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T138 [P] Write `docs/security-model.md` and `docs/threat-model.md` (three redaction layers, scope enforcement, prompt injection, known limits)
- [ ] T139 [P] Add `.github/workflows/release.yml`: Tauri bundles for macOS (signed, notarized) and Windows, sidecar per target, `pama` CLI binaries, docker image
- [ ] T140 [P] Add performance checks in `scripts/perf/`: hotkey draft p90 ≤ 3 s, digest ready p95 ≤ 2 min, Ask Link answer p90, sidecar binary ≤ 120 MB, desktop idle memory ≤ 200 MB
- [ ] T141 [P] Add a config test `crates/pama-desktop/src-tauri/tests/no_telemetry.rs` asserting the updater is off by default and no telemetry endpoint is configured (FR-028)
- [ ] T142 Write `pama doctor` in `crates/pama-cli/src/cmd/doctor.rs` (hooks installed, models reachable, permissions, strict offline config)
- [ ] T143 Update `README.md` with install, 10-minute first link walkthrough (SC-005) and architecture overview
- [ ] T144 Run all quickstart.md scenarios on macOS and Windows and record results in `specs/001-pama-mvp/checklists/release.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup; blocks all stories. The R4/R6 spikes must finish
  before the `Db` adapter and sidecar build tasks are finalized
- **US1 (Phase 3)** and **US2 (Phase 4)**: both start after Phase 2; US2 uses seeded digests so it
  does not wait for US1
- **US3 (Phase 5)**: needs the US2 answer pipeline (retrieve, answer, guard)
- **US4 (Phase 6)**: needs US1 (approved digests, review service); the link-degrade part needs US2
- **US5 (Phase 7)**: needs US2; the offline-owner test needs US4 sync
- **Polish (Phase 8)**: after the desired stories

### User Story Dependencies

```text
Setup → Foundational ─┬─ US1 ─────────┬─ US4 ─┐
                      └─ US2 ─┬─ US3  │       ├─ US5 → Polish
                              └───────┴───────┘
```

### Within Each User Story

- Tests are written first and must fail
- Schema → services/pipeline → routes → CLI/UI → end-to-end test
- Prompts and rules changes run `pnpm evals`

### Parallel Opportunities

- Phase 1: scaffolding tasks marked [P] run together after the workspace files exist
- Phase 2: the two contract tests, the rule corpus/pama.toml, the queue/egress tests and the
  device-core tasks run in parallel; the R4 and R6 spikes run in parallel
- US1 and US2 can be built by two people at the same time after Phase 2
- Inside US1: Claude and Codex adapters in parallel; Rust device work and TS server work in parallel
- US3 (desktop Rust) and US4 (sync) can run in parallel once US1 and US2 are done

---

## Parallel Example: User Story 1

```text
# Tests first, together:
Task: "Claude adapter test in crates/pama-core/tests/adapter_claude.rs"
Task: "Codex adapter test in crates/pama-core/tests/adapter_codex.rs"
Task: "Event redaction test in crates/pama-core/tests/redact_events.rs"
Task: "Digest pipeline test in apps/server/tests/integration/digest-pipeline.test.ts"
Task: "Review test in apps/server/tests/integration/review.test.ts"

# Then implementation, device and server tracks in parallel:
Task: "Claude adapter in crates/pama-core/src/session/claude.rs"
Task: "Codex adapter in crates/pama-core/src/session/codex.rs"
Task: "Digest prompt in prompts/digest.md"
Task: "Layer 2 classifier in apps/server/src/pipeline/classify.ts"
```

## Parallel Example: User Story 2

```text
Task: "Scoped repository test in apps/server/tests/integration/scoped-repo.test.ts"
Task: "Access test in apps/server/tests/integration/access.test.ts"
Task: "Guard test in apps/server/tests/unit/guard.test.ts"
Task: "Red-team cases in evals/cases/*.yaml"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Phase 1 Setup → Phase 2 Foundational (including spikes R3, R4, R6)
2. Phase 3 US1 → validate quickstart Scenario 1 → use it as a private decision log
3. Phase 4 US2 → validate Scenario 2 and `pnpm evals` = 0 leaks → first demo over LAN
4. **STOP and VALIDATE** before desktop work

### Incremental Delivery (plan.md roadmap)

- W1–W2: Phases 1–3 (US1)
- W3–W4: Phase 4 (US2); the R4/R6 spikes run earlier than plan.md's W3, in Phase 2, because they decide the Db adapter
- W5: Phases 5–6 (US3, US4)
- W6: Phase 7 (US5), Phase 8, dogfood, release v0.1

### Parallel Team Strategy

- Developer A: Rust device track (US1 adapters → US3 desktop → US4 sync worker)
- Developer B: TS server track (US1 pipeline → US2 links/answer/guard → US5 deploy)
- Developer C (optional): web UI (review, Ask Link page, console, popup) and evals

---

## Notes

- [P] = different files, no dependency on an incomplete task
- Commit after each task or logical group (conventional commits)
- Any change to `rules/`, `prompts/` or `apps/server/src/pipeline/` must keep `pnpm evals` at zero leaks
- Never add a command or API that sends messages on the owner's behalf (Constitution III)
