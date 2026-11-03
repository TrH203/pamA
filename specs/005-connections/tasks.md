# Tasks: Connections

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

## Phase 1: Shared registries (US2, US4, US5)

- [x] T001 `packages/types/providers.json` and `agents.json`, loaded by `pama-core` (`providers.rs`, `agents/mod.rs`)
- [x] T002 `AgentAdapter` trait; Claude Code and Codex ported onto it
- [x] T003 [P] Cursor and OpenCode transcript parsing with fixtures (`session/cursor.rs`, `session/opencode.rs`, `tests/adapter_cursor_opencode.rs`)
- [x] T004 Widen the device agent CHECK; migration by column name in a transaction (`tests/store_agent_check.rs`)

## Phase 2: CLI (US1-US4)

- [x] T005 `pama connect <url> [--code]`; `login` and `pair` print a deprecation note
- [x] T006 `pama use local|<url>` with preview and confirmation; refuses a server without a device token
- [x] T007 `pama server list|use|forget`; `remote::repair` keeps default target and server list consistent
- [x] T008 `pama keys list|set|test|remove` (stdin only, never printed)
- [x] T009 `pama agents [list]|enable|disable|uninstall`, per-agent enable flags, Codex notifier chaining
- [x] T010 `pama model show` from `/v1/models/effective`; `model setup --preset`
- [x] T011 `pama doctor` sees project-scope (personal and shared) hooks
- [x] T012 `config set` validates provider ids against the registry
- [x] T013 [P] `tests/connections_cli.rs`

## Phase 3: Server (US2, US5)

- [x] T014 `src/llm/registry.ts`; presets map onto openai-compatible with a default endpoint
- [x] T015 Saved > env > default with `origin`; `GET /v1/models/effective`
- [x] T016 Migration `0014_more_agents.sql`
- [x] T017 [P] `tests/integration/connections.test.ts`, `tests/unit/provider-registry.test.ts`, shared locality fixture

## Phase 4: Desktop

- [x] T018 Background loop follows remote mode (`background.rs`, `commands.rs`)

## Phase 5: Review fixes

- [x] T019 Codex: only the top-level `notify` is chained or restored; invalid TOML never rewritten
- [x] T020 Claude and Cursor: a hook is pamA's only when its executable is `pama`
- [x] T021 `connect --code` keeps home in remote mode; forgetting the home server says where home moved
- [x] T022 OpenCode hook looks the session up directly
- [x] T023 Local server start lock: `ensure_started` takes `PAMA_HOME/server.lock` and re-checks health after acquiring it, so concurrent commands start one server and `server.json` keeps the running server's token (unit tests `concurrent_starts_start_one_server`, `a_failed_start_releases_the_lock` in `cmd/server.rs`)

## Phase 6: CLI output (plan §7.4)

- [x] T024 `crates/pama-cli/src/ui.rs`: headings, key–value blocks, comfy-table tables, status marks (✓ ✗ ! … ·) that never rely on colour, `✗ <code>: <message>` + `→ <fix>` errors, indicatif spinners; anstream honours `NO_COLOR`, `CLICOLOR_FORCE` and non-TTY; `--json` output unchanged
- [x] T025 Applied to `status`, `doctor`, `activity` (list, show, follow, retry), `model show|check`, `keys list|test`, `agents`, `sync status|now|failed`, `tasks|sessions|digests list`, `conversations list`, `chat`, `review`, `link list`, `server start|stop|status`, `server list|use`, `connect`, `use`, `scan`, `capture drain`; API errors print a code and a fix
- [x] T026 [P] Unit tests for `ui` (marks, error format, key–value, table, spinner off for JSON); existing table and conversation-list tests compare plain text

## Open

- [ ] T027 Connections page in the console (data location, models, agents, devices cards): spec 009 screens
- [ ] T028 Desktop sidecar start (`crates/pama-desktop/src-tauri/src/sidecar.rs`) should take the same `server.lock` as the CLI so the app and a CLI command never start two servers
- [ ] T029 One `profile` table replacing `mode`, `sync.default_target` and `remote.servers` (deferred; `remote::repair` keeps them consistent)
- [ ] T030 Device list in the CLI (`pama devices` over `GET /v1/devices`, with revoke)
- [ ] T031 `--json` for the remaining human-only commands (`model setup`, interactive `chat`)
