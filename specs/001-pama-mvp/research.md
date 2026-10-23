# Phase 0 Research: pamA MVP v0.1

**Date**: 2026-10-22 · **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

Each entry: **Decision**, **Rationale**, **Alternatives considered**. Items marked
**VERIFY** are accepted with a mitigation and become early spike tasks (see plan § Risks).

---

## R1. Capturing Claude Code sessions

- **Decision**: Install a `SessionEnd` hook (plus `Stop` as a fallback signal) in the user scope
  `~/.claude/settings.json` (opt-in per project via `pama init` writing `.claude/settings.local.json`).
  The hook command is a tiny `pama hook claude` invocation that only enqueues
  `{session_id, transcript_path, cwd, reason}` into the local outbox and exits immediately. The
  desktop/daemon processes the transcript asynchronously. A file watcher on
  `~/.claude/projects/**.jsonl` (debounced, idle ≥ 2 min) is the fallback when hooks are missing.
- **Rationale**: hook stdin includes `session_id`, `transcript_path`, `cwd`, `hook_event_name`;
  `SessionEnd` has a default timeout of only 1.5 s and the transcript is written asynchronously,
  so heavy work inside the hook is unsafe. Transcript path is
  `~/.claude/projects/<cwd with "/"→"-">/<sessionId>.jsonl`; records carry `uuid`, `parentUuid`,
  `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `message` with content blocks `text`,
  `thinking`, `tool_use`, `tool_result`. Subagent transcripts live under
  `<project>/<session>/subagents/agent-<id>.jsonl`.
- **Constraint**: the JSONL schema is undocumented and changes across versions → the parser MUST
  ignore unknown record types and be covered by fixture tests per Claude Code version.
- **Alternatives**: parse only on watcher (no hook) — slower, misses `reason`; `Stop` only — fires
  every turn, too noisy.
- Sources: https://code.claude.com/docs/en/hooks; local inspection (field names only).

## R2. Capturing Codex CLI sessions

- **Decision**: Read rollouts from `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`
  (default `~/.codex`). Detect completion via Codex hooks (`SessionEnd`/`Stop` in
  `~/.codex/hooks.json`) when available, else via `notify` (`agent-turn-complete`, JSON in argv)
  plus watcher idle detection. Project/branch come from the `session_meta` payload
  (`cwd`, `git.branch`, `git.commit_hash`, `git.repository_url`).
- **Rationale**: envelope `{timestamp, type, payload}`; types `session_meta`, `turn_context`,
  `response_item` (`message`, `reasoning` (encrypted → skipped), `function_call(_output)`,
  `custom_tool_call(_output)`), `event_msg` (`task_started`, `task_complete`, ...).
- **VERIFY**: maturity of Codex hooks varies by version → watcher fallback is mandatory.
- Sources: https://learn.chatgpt.com/docs/config-file/config-advanced, https://learn.chatgpt.com/docs/hooks;
  local inspection.

## R3. Layer-1 redaction rules

- **Decision**: Vendor gitleaks' default `gitleaks.toml` (MIT, 222 rules) into `rules/` with
  attribution, load it in Rust (`regex` crate) with **ASCII semantics** (`RegexBuilder::unicode(false)`
  or `(?-u)`), honor `keywords` prefilter, `entropy` thresholds, `secretGroup` and allowlists.
  Add pamA-specific rules: `.env*`/`*.pem`/`id_*` file reads, `env`/`printenv` outputs, connection
  strings, JWTs. Replace matches with typed placeholders `[SECRET:<rule-id>]`.
- **Rationale**: gitleaks regexes use RE2 syntax without lookarounds → compatible with Rust
  `regex`; Rust's `\d \w \s \b` are Unicode by default, so ASCII mode is required for parity.
- **VERIFY**: compile all rules in CI (raise `size_limit` if needed); parity test against
  gitleaks' own test vectors.
- **Alternatives**: shelling out to gitleaks binary (extra dependency, slower per-chunk);
  TruffleHog (AGPL – excluded by constitution).

## R4. Server runtime, DB and local mode

- **Decision**: Server on **Node.js 24 LTS** + Hono + Drizzle. Storage behind a `Db` adapter:
  `node-postgres` + PostgreSQL 16/pgvector (self-host, cloud) and **PGlite 0.5.x** +
  `@electric-sql/pglite-pgvector` (local mode, persisted to the app data dir).
- **Rationale**: PGlite supports Node/Bun, Drizzle has `drizzle-orm/pglite`; same SQL in all modes
  satisfies Constitution IV. Node 22 enters end-of-life in April 2027, so Node 24 LTS is chosen
  (constitution amended to v1.0.1, PATCH).
- **VERIFY** (spike, week 3): (a) `USING hnsw` index on PGlite; (b) RLS under a non-superuser role
  with `SET ROLE` per transaction on PGlite. **Mitigation** regardless of outcome: all reads go
  through a scoped repository that always applies `source_id = ANY($allowed)`; RLS is an
  additional layer where it works. Both are covered by the same contract tests.
- **Spike result (2026-10-22, PGlite 0.5.11, pglite-pgvector 0.0.12)**: **PASS**. `USING hnsw
  (embedding vector_cosine_ops)` is created and chosen by the planner; RLS filters rows for a
  `NOLOGIN` role switched with `SET LOCAL ROLE` inside a transaction, with the scope passed via
  `set_config('pama.allowed_session_ids', …, true)`. RLS is therefore enabled in local mode too.
  Test: `apps/server/spikes/pglite-hnsw-rls.test.ts`.
- **Alternatives**: SQLite + sqlite-vec for local (two SQL dialects, duplicated queries); full
  Postgres bundled in desktop (heavy, ~100 MB+, service management).

## R5. Job queue

- **Decision**: `JobQueue` interface (`send`, `work`, `schedule`). Server modes: **pg-boss 12.x**.
  Local mode: in-process worker polling a `jobs` table (single connection, status-flag updates).
- **Rationale**: pg-boss expects a connection pool; PGlite has a single connection.
- **Alternatives**: pgmq extension on PGlite (unverified at scale); Redis/BullMQ (extra service,
  violates Constitution VI).

## R6. Packaging the server as a desktop sidecar

- **Decision**: Compile the server with **`bun build --compile`** per target
  (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`) on per-OS CI runners; embed PGlite
  `.wasm`/`.data` assets and pass them explicitly (`pgliteWasmModule`, `initdbWasmModule`,
  `fsBundle`). Register as Tauri `bundle.externalBin` (`pama-server-<target-triple>`).
- **Rationale**: mature cross-compilation and asset embedding; Node SEA is still "active
  development" and Node 22 lacks the 25.5+ improvements.
- **VERIFY** (spike, week 3): PGlite initdb under Bun's Wasm runtime (WebKit bug 285466;
  workaround `BUN_JSC_useWasmIPInt=false`). The full server test suite also runs against the
  compiled binary in CI. **Fallback**: Node SEA (v24+) or bundled Node runtime.
- **Spike result (2026-10-22, Bun 1.4.4, darwin-arm64)**: **PASS** without the WebKit
  workaround. Hono + PGlite + pgvector compile to one 102 MB binary; first start (initdb) 0.9 s,
  reopen 0.12 s. PGlite cannot open extension tarballs inside `$bunfs`, so the sidecar copies
  `vector.tar.gz` to the app data dir on start and passes it as `bundlePath`. Size is close to
  the 120 MB budget: the full server build must be measured (Polish task). Node SEA stays the
  fallback. Script: `scripts/spike-bun-compile.sh`.
- **Alternatives**: `pkg` (unmaintained upstream); shipping Node + `node_modules` (large, slow).

## R7. LLM and embeddings

- **Decision**: Vercel **AI SDK v7** (`ai`). Providers: `@ai-sdk/anthropic`,
  `@ai-sdk/openai-compatible` (vLLM, any OpenAI-compatible server), `ollama-ai-provider-v2`
  (Ollama). Structured output via `generateText({ output: Output.object({ schema }) })` with Zod.
  Defaults: digest/classify/judge = small model (Claude Haiku 5.5 or local 7–14B),
  answer = Claude Sonnet 5.5 or local model; all configurable per workspace.
- **Digest location**: Digesting runs in the **server pipeline** (local sidecar in local mode, or
  the user's own self-host), always on transcripts already passed through Layer-1 redaction on the
  device. In cloud mode digesting stays on the device's sidecar; only approved digests sync.
  This keeps one TypeScript implementation (Constitution IV) while satisfying Constitution I.
- **Embeddings**: **bge-m3** (1024-dim, multilingual, 8K ctx) via Ollama by default; configurable
  (e.g. qwen3-embedding). Embedding dimension is stored per workspace; changing model triggers
  re-embedding.
- **Rationale**: cross-lingual retrieval (English digests, Vietnamese questions) requires a
  multilingual embedder.
- **Alternatives**: Rust-side digest client (duplicates prompt/pipeline logic in two languages —
  rejected); nomic-embed-text-v2 (512-token context).

## R8. Desktop shell, hotkey and selection capture

- **Decision**: **Tauri 2.12.x** with plugins global-shortcut 2.4, clipboard-manager 2.5,
  shell 2.5 (sidecar), positioner 2.4 (tray only), autostart 2.7, notification 2.7, updater 2.14.
  Popup placed with `AppHandle::cursor_position()`.
  Selection capture order: (1) Accessibility API (macOS AX selected text) / UI Automation
  (Windows) when available; (2) fallback: snapshot clipboard with **arboard 3.7** (text, HTML,
  image, file list), simulate copy with **enigo 0.6**, poll `NSPasteboard.changeCount` /
  `GetClipboardSequenceNumber` every 10 ms up to 300 ms, read text, restore snapshot.
  Paste: write draft, simulate paste, restore previous clipboard after 500 ms.
- **Rationale**: matches Constitution III (clipboard limited to the question, restored).
- **Known limits**: macOS needs Accessibility permission (checked at startup, deep-link to System
  Settings); Windows UIPI blocks input into elevated windows; exotic clipboard formats (RTF,
  app-private) cannot be restored — documented.
- **Alternatives**: pot-app/Selection (GPL-3.0 — reference only, not linked).

## R9. Shared types Rust → TypeScript

- **Decision**: **typeshare 1.0.x / typeshare-cli 1.13.x** for the digest/link schemas defined in
  `pama-core`; generated into `packages/types`. JSON Schema of `SessionDigest` is also exported
  (contracts/session-digest.schema.json) and validated on both sides (contract tests).
- **Alternatives**: tauri-specta v2 (still RC; would add typed Tauri commands — revisit post-MVP);
  ts-rs (fine, but typeshare is already named in the constitution).

## R10. Secrets storage, file watching

- **Decision**: `keyring-core 1.0` + `apple-native-keyring-store` / `windows-native-keyring-store`
  for device tokens and API keys; `notify 8.2` + `notify-debouncer-full 0.7` for watching agent
  session directories.

## R11. Ask Link access, email and auth

- **Decision**: Access modes `open | pin | email_otp | allowlist`. PIN hashed with argon2id;
  OTP 6 digits, 10-minute TTL, 5 attempts; lockout 15 min after 5 failed PINs (per visitor+IP).
  Email via **nodemailer 10.x** SMTP (operator-configured). Owner console sign-in: email magic
  link on server modes; local mode binds the console to `127.0.0.1` with a per-launch token
  (no sign-in). Visitor sessions: signed, httpOnly cookie scoped to `/a/<slug>`.
- **Implementation note (2026-10-23)**: PINs and one-time codes are hashed with **scrypt from
  `node:crypto`** (N=16384, r=8, p=1) instead of argon2id: argon2 is a native module, which the
  Bun-compiled sidecar (R6) would have to ship per platform. scrypt is memory-hard and built in.
- **Alternatives**: OAuth providers (out of MVP scope; SSO deferred).

## R12. Exposure of local-mode links

- **Decision**: Local server binds to `127.0.0.1` by default; the owner can enable LAN binding or
  use **Tailscale Funnel** (TLS terminates on the owner's device) — documented, not bundled.
  Cloudflare Tunnel documented with the warning that TLS terminates at Cloudflare.

## R13. Strict offline mode and network log

- **Decision**: Application-level egress control: every outbound HTTP client (Rust `reqwest`,
  Node `undici` global dispatcher) goes through a guard that checks a declared-host allowlist and
  appends to a `network_log` table. Strict mode = deny all undeclared hosts. Telemetry: none in
  MVP. Updater checks disabled unless the owner opts in.
- **Limitation**: not an OS firewall; third-party processes (e.g. Ollama) are outside scope and
  documented as such.

## R14. Answer safety pipeline (Layer 2/3)

- **Decision**:
  - Layer 2 (ingest): TypeScript PII rules (email, phone, Vietnamese national ID/CCCD, bank
    account, IBAN-like) + LLM classifier assigning labels `business_sensitive | infra | customer`.
  - Retrieval: hybrid (pgvector cosine + Postgres full-text) over `digest_items` of the link's
    sources only; top-k = 8.
  - Answer prompt: system policy → owner instruction → retrieved items wrapped as data →
    question wrapped as data. Output schema: `{status, answer, citations[], confidence}`.
  - Layer 3: rule re-scan (L1+L2 rules ported to TS via the same `rules/` files) + LLM judge
    `{leak, off_scope, unsupported_claims}`; any failure ⇒ `refused` + forward offer.
  - Confidence threshold default 0.7 (cloud models) / 0.8 (local models).
- **Evals**: `evals/` contains ≥ 50 adversarial cases (secret extraction, cross-scope probing,
  prompt injection via question and via transcript, hallucinated decisions, language switching),
  run by `pnpm evals` against fixture digests; zero-leak gate in CI.

## Resolved clarifications

All Technical Context items are resolved; no `NEEDS CLARIFICATION` remains. Open VERIFY spikes:
R4 (PGlite HNSW + RLS), R6 (PGlite under Bun compile), R2 (Codex hooks by version), R3 (rule
compilation) — each with a defined fallback.
