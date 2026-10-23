# CLI Contract: `pama`

Global flags: `--json` (machine output on stdout), `--server <url>` (default: local sidecar),
`-v` verbosity. Errors go to stderr; exit codes: `0` ok, `1` user error, `2` config/auth,
`3` network/server, `4` safety refusal (e.g. redaction self-check failed).

| Command | Behaviour | Notes |
|---|---|---|
| `pama init [--project <path>] [--agent claude\|codex\|all]` | Enables capture for a project: writes the Claude Code hook into `.claude/settings.local.json` (or user scope with `--global`), registers Codex hook/notify, creates device store | Idempotent; prints what changed; never edits committed settings without `--project-scope` |
| `pama hook claude` | Hook entrypoint; reads hook JSON on stdin, enqueues `{session_id, transcript_path, cwd, reason}` and exits < 200 ms | Never processes the transcript inline |
| `pama hook codex [<json>]` | Same for Codex hooks (stdin) or `notify` (argv JSON) | |
| `pama scan [--since <dur>]` | Watcher fallback: find ended sessions not yet captured | |
| `pama review [--approve <id>\|--discard <id>\|--edit <id>]` | Lists draft digests; interactive approve/edit/discard | Edit opens `$EDITOR` with digest JSON |
| `pama link create --source <ref>... [--suggest "<query>"] [--expires 7d] [--detail summary] [--deny <label\|topic>]... [--instruction "<text>"] [--access pin\|open\|email_otp\|allowlist] [--pin <pin>] [--allow <email\|*@domain>]...` | Creates an Ask Link; prints URL (and PIN if generated) | `--suggest` pre-selects suggested sources |
| `pama link list` · `pama link revoke <slug>` | | |
| `pama inbox` · `pama reply <ask_id> "<text>"` | Owner inbox | |
| `pama log [--link <slug>] [--status ...]` | Audit log | |
| `pama sync status` · `pama sync enable\|disable --project <id>\|--bundle <id> [--target <url>]` | Per-source sync; `disable` issues tombstones | Default off |
| `pama pair <code> --server <url>` | Pair this device with a self-host/cloud server | Token stored in OS keychain |
| `pama server start\|stop\|status` | Manage the local sidecar when the desktop app is not running | Binds 127.0.0.1 unless `--lan` |
| `pama doctor` | Checks hooks, models reachable, permissions, strict offline config | |
| `pama config set <key> <value>` | `provider.*`, `strict_offline`, `declared_hosts`, `hotkey.answer_source` | Secrets go to keychain |

`--json` output schemas mirror the HTTP API response bodies.
