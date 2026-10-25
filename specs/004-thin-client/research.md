# Research: Thin Client

## R1 — Device login flow

- **Decision**: RFC 8628-style device authorization grant. `POST /v1/auth/device/start` returns
  `device_code` (secret, 32 bytes), `user_code` (8 chars `XXXX-XXXX`, unambiguous alphabet),
  `verification_uri` (`<base>/?device=XXXX-XXXX`), `interval` 2 s, `expires_in` 600 s. The CLI
  polls `POST /v1/auth/device/token`; the owner approves in the console after the existing email
  sign-in (magic link). On approval the server creates the `devices` row and returns the token to
  the next poll exactly once.
- **Rationale**: works headless (approve from another device), no localhost callback port, no
  OAuth provider, reuses magic-link sign-in and the `devices` table.
- **Alternatives**: localhost redirect (fails over SSH, firewall prompts); pasting the owner token
  (exposes an operator secret); keeping only pairing codes (two manual steps — kept as fallback).

## R2 — Device token on owner routes

- **Decision**: in `authenticate()`, after `DEVICE` paths, accept a valid device token on any
  non-public, non-local-only route, acting in the device's workspace. Update `last_seen_at`.
- **Rationale**: the CLI then reuses every owner endpoint; same pattern as `gh`/`vercel` CLIs.
- **Alternatives**: separate `/v1/device/*` mirror routes (duplication); exchanging the device
  token for a session cookie (stateful, awkward for a CLI).

## R3 — Where drafting runs and how it stays consistent

- **Decision**: port `digestTranscript`'s model step to Rust (`pama_core::draft`):
  `format_transcript` (same head 12 000 / budget 48 000 chars, same tags), system prompt =
  `prompts/digest.md` body (embedded via `include_str!`, version parsed from front matter), the
  same output schema (goal, decisions[what, why, alternatives], outcome, open_items, modules) and
  the same caps (1000/500/100 chars, 30 decisions, 20 open items, 10 alternatives, 30 modules).
  The device re-applies Layer 1 to every output string before storing/sending.
- **Rationale**: Principle I forbids transcript egress to the server; Node on the device defeats
  the feature.
- **Alternatives**: WASM build of the TS pipeline (heavy, AI SDK not portable); server-side
  drafting of redacted events (violates Principle I).

## R4 — LLM calls from Rust

- **Decision**: blocking reqwest through `GuardedClient` (egress policy + network log).
  - Anthropic Messages API `POST {base}/v1/messages`, headers `x-api-key`,
    `anthropic-version: 2023-06-01`; structured output by a single forced tool
    (`tool_choice: {type: "tool", name: "session_digest"}`) whose `input_schema` is the draft
    schema; `temperature: 0`, `max_tokens: 4096`.
  - OpenAI-compatible `POST {base}/chat/completions` with `response_format: {type: "json_object"}`
    and the JSON schema appended to the system prompt.
  - Ollama `POST {base}/api/chat` with `format: <json schema>`, `stream: false`,
    `options.temperature: 0`.
  - Settings reuse the device keys already passed to the sidecar: `provider.chat.provider`,
    `provider.small.model` (falls back to `provider.chat.model`), `provider.chat.base_url`; key
    from keychain `provider.<provider>.key`. Defaults: Ollama `qwen3:14b` at
    `http://127.0.0.1:11434`.
  - Timeouts 120 s; 429/5xx/connection errors are retryable (capture backoff), 4xx fatal.
- **Alternatives**: an LLM crate (new dependency, little gain for three JSON calls).

## R5 — Source of truth and pull-back (FR-025)

- **Decision**: device table `remote_digest` keyed by (server, agent, agent_session_id) holds the
  latest drafted digest, its review status, the server digest id/version and `updated_at`. The
  server exposes `GET /v1/sync/changes?since=<cursor>` (device token) listing digests of the
  device's workspace whose review state changed (`status`, `version`, `content` for approved
  edits, `changed_at`), ordered by a monotonic `changed_at` + id cursor. The device applies them
  in `Api::connect` for remote targets (throttled: at most once per 60 s) and at the end of each
  drain. Device deletions (sync off) are sent as tombstones via the existing outbox and always win.
- **Alternatives**: push notifications (no daemon in remote mode); server as truth (rejected by
  owner, 2026-10-25 clarification).

## R6 — Draft ingest on the server

- **Decision**: `POST /v1/sync/drafts` (device token) reuses `ingestDigest` with
  `status: "draft"`, records `origin_device_id`, applies the project's auto-approve, and is
  idempotent by `outbox_id` (receipts) and by digest hash per session. A newer draft for the same
  session creates a new version (as local mode does).
- **Alternatives**: a separate pipeline (duplication).

## R7 — Per-workspace answering model (FR-026)

- **Decision**: table `workspace_model_settings (workspace_id, role='chat', config jsonb with
  encrypted key)`. In cloud mode, `PUT /v1/models/settings/chat` from a session/device writes the
  workspace override; the owner token (operator) writes the global setting. `answerQuestion` and
  drafts use `modelsFor(deps)` that swaps `chat` when an override exists (cached per workspace,
  invalidated on write). Embedding and small models stay operator-wide (vector dimensions must be
  uniform for the shared index).
- **Alternatives**: per-workspace embeddings (re-index per workspace; deferred).

## R8 — Console from the CLI

- **Decision**: `POST /v1/auth/device/console-link` (device token) creates a one-time
  `login_tokens` row (5 min) for the workspace owner and returns `<base>/v1/auth/callback?token=`;
  `pama console` opens it. In local mode nothing changes.

## R9 — Mode and multiple servers on the device

- **Decision**: settings `mode` (`local` | `remote`, default `local` for existing installs) and
  `remote.servers` (JSON list of `{url, workspace, device_id}`), `sync.default_target` (existing)
  is the default server. Tokens per server in the keychain under `device-token:<url>` (existing
  `token_key`). `--server <url>` selects a logged-in server for one command; unknown → exit 2 with
  "run `pama login --server <url>`".
- Per-project sync in remote mode: setting `remote.sync_projects` (JSON list of project keys).
  `pama init` in remote mode asks (or `--sync`) and `pama sync enable|disable --project <key|path>`
  edits it; disabling queues a project tombstone.

## R10 — Cloud deployment

- **Decision**: reuse `deploy/docker-compose.yml` with `PAMA_MODE=cloud`, a reverse proxy for
  HTTPS (Caddy example), SMTP for sign-in, `PAMA_SECRET`, operator models, backups via
  `pg_dump`, upgrades by image tag. Documented in `docs/deploy-cloud.md`.
