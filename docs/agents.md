# Supported agents and capture

pamA reads agent transcripts **on the owner's machine**. Raw transcripts are never uploaded; only
Layer-1-redacted events go to the local server, and only approved digests can sync.

Every agent is an adapter (`crates/pama-core/src/agents/`, trait `AgentAdapter`): transcript
dirs, parsing into the shared session event model, hook install/uninstall/status per scope, and
the idle delay before a capture is read. The list of agents is shared with the server in
`packages/types/agents.json` (the server's `AgentSchema`, the `sessions_agent` check and the
digest JSON schema all accept the same ids).

## Managing agents

```bash
pama agents                                 # detected, capture on/off, hooks per scope, recent sessions
pama agents enable cursor --global          # capture on + user-scope hook
pama agents enable codex --project .        # hook in this project only (--shared: committed config)
pama agents disable opencode                # capture off; hooks stay but are ignored
pama agents uninstall claude                # remove pamA's hooks everywhere (user + captured projects)
```

Capture is on by default for every agent; `disable` turns it off per agent (the setting
`agents.<id>.enabled`). `pama init` installs Claude Code and Codex hooks as before, plus Cursor and
OpenCode when they are used on the machine. `pama doctor` reports hooks in every scope, including
ones installed with `--project-scope`.

## Claude Code

| Item | Value |
|---|---|
| Transcript | `~/.claude/projects/<cwd with non-alphanumerics → "-">/<session>.jsonl` (`$CLAUDE_CONFIG_DIR/projects` if set) |
| Subagents | `<project>/<session>/subagents/agent-*.jsonl`, merged into the session |
| End signal | `SessionEnd` hook → `pama hook claude` (installed by `pama init`) |
| Fallback | `pama scan` (transcripts idle ≥ 2 min) |
| Records used | `user`, `assistant` (text, `tool_use`, `tool_result`); `isMeta` and all other record types are ignored; thinking blocks are not used |

Verified against Claude Code **2.1.0 fixtures** and a real **2.1.304** transcript (2026-10-22):
metadata, tool/result linking and record filtering all hold. The JSONL format is undocumented;
unknown record types and fields are ignored and every format change gets a fixture in
`crates/pama-core/tests/fixtures/claude/<version>/`.

## Codex CLI

| Item | Value |
|---|---|
| Transcript | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (default `~/.codex`) |
| End signal | `notify` program → `pama hook codex` (after every turn; captured after 2 min idle), or a `SessionEnd` hook where available |
| Fallback | `pama scan` |
| Records used | `session_meta`, `response_item` (`message`, tool calls and outputs); `event_msg` duplicates and encrypted `reasoning` are skipped |

### R2 verification (2026-10-22)

| Codex version | Tool calls | Output shape | Status |
|---|---|---|---|
| 0.80 (fixture) | `function_call` `shell` with `{"command": ["bash","-lc", …]}` | string or `{"output": …}` envelope | supported |
| **0.149.1** (real session) | `custom_tool_call` **`exec`** whose `input` is a JavaScript code cell; `wait` polls it | list of `{type: "text", text}` | supported since this check |

Findings that changed the code:

- Code mode means shell commands are inside JS code, so the `bash` structural rules never saw
  them. The `exec` cell's code is now the event's `command`, and the structural rule
  `code-cell-secret-access` (rules/pama.toml) drops the output of any cell that touches `.env`,
  key files, credentials or the process environment.
- List-shaped outputs are joined instead of being kept as JSON.

`notify` still fires per turn, so capture is debounced; the watcher fallback stays mandatory.

**Notify chaining (spec 005).** Codex has one `notify` program. When another notifier is already
configured, pamA no longer refuses: it writes `notify = ["pama", "hook", "codex", "--chain",
<previous argv…>]` and runs the previous notifier with the same payload after recording the
capture. `pama agents uninstall codex` restores the previous notifier.

## Cursor

| Item | Value |
|---|---|
| Transcript | `~/.cursor/projects/<workspace slug>/agent-transcripts/<id>.jsonl` or `<id>/<id>.jsonl` (`$CURSOR_HOME/projects` if set) |
| End signal | Cursor hooks (`~/.cursor/hooks.json` user scope, `<project>/.cursor/hooks.json` project scope): `stop` (after each agent loop, debounced 2 min) and `sessionEnd` → `pama hook cursor` (JSON on stdin with `conversation_id`, `transcript_path`, `workspace_roots`) |
| Fallback | `pama scan` |
| Records used | rows `{"role": "user"\|"assistant", "message": {"content": [...]}}` with `text` and `tool_use` blocks |

The transcript format is undocumented and lossy (no tool results, few timestamps); unknown rows
and fields are ignored. The project directory is recovered from the slug when no hook payload
gives it. Fixtures: `crates/pama-core/tests/fixtures/cursor/`.

## OpenCode

| Item | Value |
|---|---|
| Sessions | `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`, or `$OPENCODE_DATA_DIR`): SQLite `opencode.db` (tables `session`, `message`, `part`) since 1.2, JSON files under `storage/session|message|part/` before. Both are read, read-only; the database wins over legacy copies |
| End signal | a plugin pamA installs (`~/.config/opencode/plugins/pama.js` user scope, `<project>/.opencode/plugins/pama.js` project scope) that runs `pama hook opencode <json>` on `session.idle` (after every turn, debounced 2 min) |
| Fallback | `pama scan` |
| Records used | `text`, `tool` (input, output, status) parts of user and assistant messages; reasoning, snapshot and step parts are skipped |

Fixtures: `crates/pama-core/tests/fixtures/opencode/` (legacy files; the SQLite layout is built
from them in the test).

