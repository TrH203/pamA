# Implementation Plan: Connections

**Branch**: `005-connections` | **Spec**: [spec.md](spec.md) | **Source**: docs/plans/v0.2-overhaul.md §3

## Summary

One provider registry and one agent registry shared by Rust and TypeScript; CLI commands to
connect servers, switch home, manage keys and agents; an effective-models endpoint with origins;
two new agent adapters (Cursor, OpenCode). Connection state stays in the existing device
settings (`mode`, `sync.default_target`, `remote.servers`), kept consistent by
`remote::repair`, instead of a new profile table.

## Technical Context

- Device: Rust, `crates/pama-core` (registries, adapters, store), `crates/pama-cli` (clap),
  `crates/pama-desktop/src-tauri` (background loop).
- Server: TypeScript, Hono; migration `0014_more_agents.sql`.
- Shared data: `packages/types/providers.json`, `packages/types/agents.json`,
  `packages/types/fixtures/provider-locality.json`.

## Design

### Core (`crates/pama-core`)

- `providers.rs`: loads `providers.json` (embedded at build time); `is_local`, `key_name`,
  `test_key` (lists models through the egress guard), presets.
- `agents/{mod,claude,codex,cursor,opencode}.rs`: `AgentAdapter` trait and registry; hook
  install/uninstall per scope (user, project personal, project shared), `hook_locations`,
  `enabled` flags per agent. `session/{cursor,opencode}.rs`: transcript parsing.
- `remote.rs`: `Home` (local | server url), `home`, `preview_switch`, `switch_home`, `servers`,
  `set_default_server`, `repair`.
- `store`: widened agent CHECK on `captured_session`, migrated by column name in a transaction.

### CLI (`crates/pama-cli`)

- `cmd/connect.rs`: `connect`, `use`, `server list|use|forget`.
- `cmd/keys.rs`: `keys list|set|test|remove`.
- `cmd/agents.rs`: `agents [list]|enable|disable|uninstall`.
- `cmd/model.rs`: `model show` from `/v1/models/effective`, `model setup --preset`.
- `cmd/server.rs`: `ensure_started` takes `PAMA_HOME/server.lock` (fs4) and re-checks health
  before spawning.
- `ui.rs` (plan §7.4): shared terminal output (headings, key–value blocks, comfy-table tables,
  status symbols, `✗ code: message` + `→ fix`, indicatif spinners); colour through anstream
  (`NO_COLOR`, `CLICOLOR_FORCE`, non-TTY); `--json` untouched.

### Server (`apps/server`)

- `src/llm/registry.ts` reads `providers.json`; `config.ts` / `settings.ts` resolve
  saved > env > default with an origin; `routes/models.ts` adds `GET /v1/models/effective`.
- Migration 0014 widens `sessions_agent` to `claude_code, codex, cursor, opencode`.

### Desktop

- `background.rs` follows remote mode; `commands.rs` exposes the home to the UI.

## Testing

- Rust: `crates/pama-core/tests/adapter_cursor_opencode.rs`, `store_agent_check.rs`,
  `crates/pama-cli/tests/connections_cli.rs` (keys never printed, connect/use errors, agents
  enable/disable/uninstall, doctor sees shared hooks, config validation), unit tests for
  `server::start_once` and `ui`.
- Server: `tests/integration/connections.test.ts`, `tests/unit/provider-registry.test.ts`.
