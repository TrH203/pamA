# Supported agents and capture

pamA reads agent transcripts **on the owner's machine**. Raw transcripts are never uploaded; only
Layer-1-redacted events go to the local server, and only approved digests can sync.

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
