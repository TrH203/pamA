# Implementation Plan: pamA MVP v0.1 (Please Ask my AI)

**Branch**: `001-pama-mvp` | **Date**: 2026-10-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-pama-mvp/spec.md`

## Summary

pamA captures AI coding-agent sessions (Claude Code, Codex CLI) on the owner's machine, redacts
secrets locally, distills English **Session Digests** of goals and decisions, and lets other people
get answers through an **Ask Link** (browser, any language, cited, scoped, escalates to the owner)
or lets the owner draft answers anywhere with a **global hotkey** (clipboard, never auto-sends).

Technical approach: a Rust workspace (`pama-core` for session parsing + Layer-1 redaction,
`pama-cli`, `pama-desktop` on Tauri 2) runs on the device; a single TypeScript server (Hono +
Drizzle + AI SDK) implements digesting, policy, retrieval, answering and the web UI, and runs in
three modes — as a compiled **sidecar with PGlite** on the device (local), via **docker compose**
with PostgreSQL + pgvector (self-host), or as **pamA Cloud** (same image). Sync of approved digests
from device to a remote server is opt-in per source. See [research.md](./research.md).

## Technical Context

**Language/Version**: Rust stable (edition 2021, MSRV 1.85); TypeScript 5.x on Node.js 24 LTS;
sidecar compiled with Bun (`bun build --compile`).

**Primary Dependencies**:
- Rust: tauri 2.12 (+ global-shortcut 2.4, clipboard-manager 2.5, shell 2.5, positioner 2.4,
  autostart 2.7, notification 2.7, updater 2.14), enigo 0.6, arboard 3.7, notify 8.2 +
  notify-debouncer-full 0.7, regex, serde/serde_json, reqwest, rusqlite (outbox),
  keyring-core 1.0 + native stores, typeshare 1.0, clap.
- TypeScript: hono + @hono/node-server, drizzle-orm (node-postgres, pglite), @electric-sql/pglite
  0.5 + pglite-pgvector, pg-boss 12, ai v7 + @ai-sdk/anthropic + @ai-sdk/openai-compatible +
  ollama-ai-provider-v2, zod 4, nodemailer 10, argon2; web: React 19 + Vite + Tailwind.

**Storage**: Device: SQLite outbox (Rust) + PGlite data dir (local mode). Server: PostgreSQL 16 +
pgvector (HNSW, 1024-dim bge-m3 default). Raw transcripts are never copied; only read in place.

**Testing**: `cargo test` (unit + fixture tests per agent version), `cargo clippy -D warnings`;
Vitest for TS unit/integration (against PGlite and a Postgres service container); contract tests
for the shared schema (Rust serde ↔ JSON Schema ↔ Zod); Playwright for the Ask Link page;
`evals/` red-team suite (≥ 50 cases, zero-leak gate).

**Target Platform**: Desktop macOS 13+ (arm64, x64) and Windows 10/11 x64; server Linux x64/arm64
containers; askers: any modern browser.

**Project Type**: Desktop app + CLI + web service (monorepo: Cargo workspace + pnpm workspace).

**Performance Goals**: hotkey draft ≤ 3 s p90 (SC-003); digest ready ≤ 2 min p95 after session end
(SC-008); Ask Link answer ≤ 6 s p90 with cloud models, ≤ 15 s p90 with local 7–14B models;
transcript parsing + Layer-1 ≥ 20 MB/s.

**Constraints**: raw transcripts never leave the device; fully offline-capable; desktop idle
memory ≤ 200 MB including sidecar; sidecar binary ≤ 120 MB; no copyleft dependencies linked;
strict offline mode with network log.

**Scale/Scope**: MVP dogfood 3–5 owners, ≤ 10k digest items per workspace; cloud beta target
~1k owners on a single Postgres; 5 user stories, 32 FRs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Pre-research | Post-design |
|---|---|---|---|
| I. Local-first & privacy | Raw transcripts never leave device; sync opt-in per source, off by default; offline capable; no telemetry | ✅ Layer-1 + digest run on device (sidecar); sync API only accepts approved digests; offline via Ollama/vLLM | ✅ `sync_settings` default off; tombstones in contract; network log + strict mode (R13) |
| II. Defense-in-depth & scope | 3 redaction layers; scope in data layer; cite-or-escalate | ✅ L1 Rust, L2 ingest, L3 output guard | ✅ scoped repository + RLS (R4); answer schema requires citations; refusal path in API contract |
| III. Platform independence & human send | No chat bots; hotkey + link only; never auto-send; clipboard restored | ✅ | ✅ desktop IPC contract has no "send" command; paste only |
| IV. One codebase, three deployments | Same server + pipeline everywhere; pipeline once in TS | ✅ sidecar = compiled server | ✅ digesting moved into TS pipeline (R7) to avoid a Rust duplicate |
| V. Test-first safety-critical | Tests before redaction/policy/guard code; evals gate | ✅ planned as first tasks per story | ✅ contracts include fixtures + eval format |
| VI. Simplicity | Rust only on device; Postgres-only server dependency | ⚠️ Bun used as compiler for sidecar (see Complexity Tracking) | ⚠️ justified; no other services added |
| Licensing | No GPL/AGPL linked | ✅ gitleaks rules MIT (vendored with attribution); pot/TruffleHog excluded | ✅ |

Result: **PASS** with one justified deviation (Bun compiler).

## Project Structure

### Documentation (this feature)

```text
specs/001-pama-mvp/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── http-api.md
│   ├── session-digest.schema.json
│   ├── cli.md
│   ├── desktop-ipc.md
│   └── redaction-rules.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks – not created here)
```

### Source Code (repository root)

```text
crates/
├── pama-core/            # session adapters (claude, codex), normalization, Layer-1 redaction,
│   ├── src/              #   outbox, sync client, shared types (typeshare)
│   └── tests/fixtures/   #   anonymized transcripts per agent version
├── pama-cli/             # `pama` binary: init, hook, review, push, link, log, server, doctor
└── pama-desktop/         # Tauri 2 app: tray, hotkey, selection capture, popup, sidecar mgmt
    └── src-tauri/

apps/
├── server/               # Hono server (also compiled as sidecar)
│   ├── src/
│   │   ├── db/           # drizzle schema, dialect adapters (pg | pglite), migrations, RLS
│   │   ├── queue/        # JobQueue: pg-boss | in-process
│   │   ├── pipeline/     # digest, classify (L2), retrieve, answer, guard (L3), suggest
│   │   ├── policy/       # resolveLink, scoped repository, access modes, rate limits
│   │   ├── routes/       # device, owner, public (/a/:slug), sync
│   │   ├── mail/         # nodemailer
│   │   └── net/          # egress guard + network log
│   └── tests/            # unit, integration (pglite + postgres), contract
└── web/                  # React: Ask Link page, owner console, desktop popup views
    └── tests/e2e/        # Playwright

packages/
├── types/                # generated by typeshare from pama-core
└── ui/                   # shared React components (web + desktop webview)

rules/                    # redaction rules (gitleaks vendored + pamA rules), shared by Rust & TS
prompts/                  # versioned prompts: digest, classify, answer, judge, suggest
evals/                    # red-team cases + fixture digests + runner
deploy/                   # docker-compose.yml, Dockerfile, .env.example
docs/                     # self-host guide, security model, threat model
Cargo.toml                # workspace
pnpm-workspace.yaml
```

**Structure Decision**: monorepo with a Cargo workspace (`crates/`) and a pnpm workspace
(`apps/`, `packages/`). Shared, language-neutral assets (`rules/`, `prompts/`, `evals/`) live at the
root so both runtimes and contributors use one source of truth.

## Delivery Order & Risks

Mapped to the 6-week roadmap (spec stories in brackets):

1. W1 `pama-core`: Claude/Codex adapters + Layer-1 + outbox; rule-compilation CI. [US1]
2. W2 server pipeline skeleton: digest generation on sidecar, review queue, bundles, `pama review`. [US1]
3. W3 **spikes first**: PGlite HNSW + RLS (R4), PGlite under Bun compile (R6); then policy,
   links, suggestions, L2. [US2]
4. W4 Ask Link page, answer + L3 guard, inbox, audit, access modes, evals ≥ 50. [US2]
5. W5 desktop: tray, sidecar mgmt, hotkey capture/paste, popup, sync toggles, strict offline. [US3, US4]
6. W6 docker compose + self-host guide, dogfood, release v0.1, cloud beta. [US5]

| Risk | Mitigation |
|---|---|
| Agent transcript formats change | tolerant parsers, fixtures per version, watcher fallback |
| PGlite RLS/HNSW gaps | scoped repository always enforced; RLS additive; brute-force cosine OK at ≤ 10k items |
| Bun-compiled PGlite issues | CI runs tests on compiled binary; fallback Node SEA |
| Small local models weak as judge | stricter thresholds, deterministic L1/L2 rules, more escalation |
| Selection capture flaky in some apps | AX/UIA first, clipboard fallback, manual paste box always available |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Bun used as build tool for the sidecar (in addition to Node runtime) | Single-file cross-platform binary with embedded PGlite WASM assets for local mode | Node SEA still "active development" and weaker asset embedding; shipping Node + node_modules bloats the installer |
| Two storage adapters (pg, pglite) and two queue adapters | Required by Constitution IV (local + server modes from one codebase) | SQLite for local would need a second SQL dialect and duplicate queries |
