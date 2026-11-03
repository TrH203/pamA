# Feature Specification: Connections

**Feature Branch**: `005-connections` (merged into `v0.2-integration`)

**Created**: 2026-10-31 (written after the fact on 2026-11-03 from the merged code)

**Status**: Implemented (core, CLI, server, desktop loop); the Connections web page is spec 009

**Input**: docs/plans/v0.2-overhaul.md section 3. A developer who has just installed pamA can
choose where data lives, which models answer and which agents are captured within five minutes,
switch between local and a server, change a provider or key without reading code, and always see
the configuration in effect.

## User Scenarios & Testing

### User Story 1 - Connect a server and switch home (P1)

The owner runs `pama connect https://pama.example.com` (browser approval) or
`pama connect <url> --code ABCD-1234` (pairing code). The server is registered and becomes home.
`pama server list | use <url> | forget <url>` manage connected servers without logging in again,
and `pama use local | <url>` previews what changes (what stays, what syncs) and asks before
switching.

**Acceptance**: `pama use <url>` for a server without a device token refuses and says to run
`pama connect <url>`; `pama login` and `pama pair` still work but print a deprecation note;
`sync.default_target` and `remote.servers` stay consistent (forgetting the default moves it,
a default missing from the list is repaired on the next command).

### User Story 2 - See and change the models in effect (P1)

`pama model show` lists each server role (chat, small, embed) with provider, model, local or
cloud, origin (`saved`, `env`, `default`), whether a key is set and whether it was verified; in
remote mode it also shows the device's drafting model. `GET /v1/models/effective` returns the
same data without ever returning a key. `pama model setup --preset …` starts from a preset.

**Acceptance**: a saved setting wins over an environment variable, which wins over the default;
the origin label says which one applied.

### User Story 3 - Manage provider keys safely (P1)

`pama keys list` shows which providers have a key and where it is stored, never the value, and
the last test result. `pama keys set <provider>` reads the key from stdin (never argv),
`pama keys test <provider>` checks it through the egress guard, `pama keys remove` deletes it.

**Acceptance**: the key never appears in stdout, stderr or `--json` output (CLI test).

### User Story 4 - Turn agents on and off (P1)

`pama agents` lists Claude Code, Codex, Cursor and OpenCode: detected or not, capture on/off,
installed hooks and their scope, sessions in the last 7 days and captures.
`pama agents enable <id> [--global|--project <dir>] [--shared]`, `disable <id>` and
`uninstall <id>` install, ignore or remove hooks. Codex chains an existing notifier instead of
refusing.

**Acceptance**: `pama doctor` sees hooks installed in project scope (personal and shared);
uninstall only removes hooks whose executable is `pama`.

### User Story 5 - New agents: Cursor and OpenCode (P2)

Sessions from Cursor and OpenCode are parsed, captured and stored like Claude Code and Codex
sessions; the server accepts the new agent ids.

**Acceptance**: fixture transcripts for both parse into the session model
(`crates/pama-core/tests/adapter_cursor_opencode.rs`); migration 0014 widens the
`sessions_agent` check.

### Edge Cases

- A device store opened by an older build widens its agent CHECK by copying `captured_session`
  by column name, keeping later columns, inside a transaction.
- Invalid Codex TOML is never rewritten; only the top-level `notify` key is chained or restored.
- Two commands that both find the local server stopped must not start two servers (one would
  overwrite `server.json` with a token the running server does not know, giving 401s).

## Requirements

### Functional Requirements

- **FR-001**: Provider ids, default endpoints, roles, key requirement, locality and suggested
  models MUST come from one registry, `packages/types/providers.json`, read by Rust
  (`pama-core::providers`) and TypeScript (`apps/server/src/llm/registry.ts`); a shared fixture
  (`packages/types/fixtures/provider-locality.json`) keeps `is_local` in agreement.
- **FR-002**: Presets of the OpenAI-compatible protocol (`lmstudio`, `vllm`, `openai`,
  `deepinfra`) MUST store settings under the protocol id so older servers keep reading them.
- **FR-003**: `GET /v1/models/effective` MUST report each role with `origin` and never a key.
- **FR-004**: Keys MUST be read from stdin or a hidden prompt, never argv, and stored in the OS
  keychain (or `PAMA_SECRETS_FILE` in tests).
- **FR-005**: An `AgentAdapter` trait in `pama-core::agents` MUST cover id, display name,
  transcript dirs, parsing, hook install/uninstall/status per scope; agents are registered in
  `packages/types/agents.json`.
- **FR-006**: `pama connect` MUST be the one way to connect a server; `login`/`pair` remain as
  deprecated aliases.
- **FR-007**: `pama use` MUST show the consequences of a switch and ask unless `--yes`.
- **FR-008**: The desktop background loop MUST follow `home` (remote mode drafts on the device,
  delivers and pulls review decisions).
- **FR-009**: `config set` validates provider ids against the registry.
- **FR-010**: Starting the local server MUST be serialised per `PAMA_HOME` (file lock) and
  re-check health after taking the lock.

## Success Criteria

- **SC-001**: A new install reaches "connected, models verified, one agent on" with `connect`,
  `model setup` and `agents enable` only.
- **SC-002**: No command prints a stored key (covered by `tests/connections_cli.rs`).
- **SC-003**: Rust and TypeScript agree on provider locality for every registry entry.

## Out of scope / later

- The Connections page in the console (four cards: data location, models, agents, devices) is
  delivered with spec 009 screens.
- A single `profile` table replacing `mode`, `sync.default_target` and `remote.servers`: the
  existing settings are kept and kept consistent by `remote::repair` instead.
