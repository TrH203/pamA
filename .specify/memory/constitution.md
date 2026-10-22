# pamA Constitution

pamA ("Please Ask my AI") is an open-source (Apache-2.0) tool that lets a person who works with
AI coding agents have an agent answer other people's questions about that work, sharing only key
ideas and decisions while keeping secrets and sensitive details private.

## Core Principles

### I. Local-First & Privacy

- Raw agent transcripts MUST NOT leave the user's machine, in any deployment mode.
- Only distilled, redacted digests MAY leave the machine, and only when sync is enabled for that
  specific source. Sync MUST be opt-in per source and OFF by default.
- Data on the user's machine is the source of truth; servers hold replicas. Disabling sync or
  deleting a source MUST propagate a deletion to every replica.
- The full product MUST be operable offline with local models (e.g. Ollama, vLLM) and without
  any third-party service.
- No telemetry, analytics or update checks without explicit user consent. A strict offline mode
  MUST block all egress except user-declared endpoints and expose a log of network connections.

Rationale: the product reads private work sessions; trust is the product.

### II. Defense-in-Depth Redaction & Scope Enforcement

- Redaction MUST run in three layers: (1) deterministic rules + entropy checks on the user's
  machine before any LLM call; (2) PII rules + LLM classification at ingest; (3) an output check
  before any answer is shown or sent. A failing layer-3 check MUST escalate, never send.
- Access scope (which sources an Ask Link or request may read) MUST be enforced in the data layer
  (row-level security / query filters), never by prompt instructions alone.
- Every answer MUST cite the digest items it relied on. An answer without supporting items MUST be
  escalated to the owner instead of being generated.
- Stored digests and asker input MUST be treated as data, never as instructions to the model.

Rationale: prompts can be subverted; data that is never stored or never retrievable cannot leak.

### III. Platform Independence & Human-in-the-Loop Sending

- pamA MUST NOT depend on per-chat-platform bots or platform-specific APIs for its core flows.
- Entry points are: a desktop global hotkey (clipboard-based draft) and the Ask Link (a URL).
- pamA MUST NEVER send a message as the user automatically. For the hotkey flow the user always
  performs the final send; for Ask Links, answers are clearly labelled as automated on the owner's
  behalf.
- Clipboard access MUST be limited to the selected question: the previous clipboard content is
  restored and nothing else from the clipboard is stored.

Rationale: works with every chat app (including ones without APIs) and keeps the owner
accountable for what is said in their name.

### IV. One Codebase, Three Deployments

- The same server and answer pipeline MUST power all three modes: Local (desktop + sidecar server
  with PGlite), Self-host (docker compose), and pamA Cloud.
- The answer pipeline (retrieval, prompting, guard, escalation) MUST be implemented once, in
  TypeScript. Mode differences are limited to configuration and storage/queue adapters.
- The local and self-host modes MUST NOT be functionally crippled relative to the cloud; the cloud
  MAY add operational and team features (SSO, billing, audit export).

Rationale: avoids duplicated logic drifting apart and keeps the open-source edition first-class.

### V. Test-First for Safety-Critical Code (NON-NEGOTIABLE)

- Redaction rules, scope/policy resolution, and the answer guard MUST have failing tests written
  before implementation (Red → Green → Refactor).
- A public red-team evaluation suite lives in `evals/`. Every PR that changes prompts, redaction
  rules, retrieval or policy code MUST pass it; regressions block merge.
- Shared schemas (Rust → TypeScript via typeshare) MUST have contract tests on both sides.

Rationale: a single leak destroys user trust; safety properties must be proven, not assumed.

### VI. Simplicity & Development Speed

- Rust is used only where on-device performance or footprint matters (core library, CLI, Tauri
  desktop). Server and web use TypeScript.
- Minimize moving parts: Postgres (+pgvector, +pg-boss) is the only required server dependency;
  new services require a written justification in the plan's Complexity Tracking.
- YAGNI: build for the MVP scope; defer features not demanded by a current spec.
- Prefer integrating with existing ecosystems (Claude Code hooks, Codex session files, Agent Trace,
  Entire/SpecStory adapters) over building parallel infrastructure such as a custom coding harness.

Rationale: speed to a trustworthy v0.1 matters more than generality.

## Technical & Licensing Constraints

- Stack: Rust stable (2021+ edition), Tauri v2, Node.js 24 LTS, Hono, Drizzle ORM,
  PostgreSQL 16 + pgvector, pg-boss, React + Vite; PGlite for local mode; Vercel AI SDK for LLM
  providers (Anthropic, OpenAI-compatible, Ollama, vLLM).
- Supported desktop platforms for MVP: macOS and Windows.
- Project license: Apache-2.0. Code under GPL/AGPL or other copyleft licenses MUST NOT be embedded
  or linked; such tools may only be invoked as separate, optional processes.
- Stored digests are written in English; answers are produced in the asker's language and register.
- Secrets (device tokens, API keys) MUST be stored in the OS keychain, never in plain files.

## Development Workflow & Quality Gates

- Work follows the Spec Kit flow: specify → (clarify) → plan → tasks → implement, with review
  gates after spec and plan.
- Every change lands through a reviewed pull request; commits follow Conventional Commits.
- CI gates on every PR: Rust (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`),
  TypeScript (lint, typecheck, tests), contract tests for shared schemas, and the `evals/` suite
  when its trigger paths change.
- Each plan MUST include a Constitution Check against principles I–VI and record any justified
  deviation in Complexity Tracking.

## Governance

- This constitution supersedes other practices and conventions in the repository.
- Amendments are made via pull request that updates this file, includes a Sync Impact Report, and
  states the version bump rationale. Maintainer approval is required.
- Versioning: MAJOR for removing or redefining a principle; MINOR for adding a principle/section
  or materially expanding guidance; PATCH for clarifications and wording.
- Compliance: reviewers verify the Constitution Check of each plan and reject unjustified
  violations. Principles II and V are verified by the CI gates above.

**Version**: 1.0.1 | **Ratified**: 2026-10-22 | **Last Amended**: 2026-10-22
