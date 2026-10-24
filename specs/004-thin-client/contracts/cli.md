# CLI additions (004)

Exit codes unchanged: 0 ok, 1 user, 2 config/auth, 3 network, 4 safety. `--json` everywhere.

## pama login [--server <url>] [--no-browser]

Starts a device login. Prints `Open <verification_uri> and confirm code ABCD-EFGH`, opens the
browser unless `--no-browser`, polls until approved/denied/expired. On success: stores the token
in the OS keychain, adds the server to `remote.servers`, sets it as default and sets `mode=remote`.
JSON: `{server, workspace_id, device_id}`. Without `--server`, uses `$PAMA_CLOUD_URL`; if
neither is set, exit 1 asking for `--server` (no hosted pamA Cloud address is hard-coded yet).

## pama logout [--server <url>] [--discard-pending]

Revokes this device on the server (best effort), deletes the keychain token, removes the server
from `remote.servers`. Pending outbox items for that server are kept unless `--discard-pending`
(then marked dead). If no logged-in server remains, `mode=local`. JSON: `{server, pending,
discarded}`.

## pama mode [local|remote]

Without argument prints the mode, default server and logged-in servers. `remote` requires a
logged-in server (exit 2 otherwise). `local` warns when `pama-server` is not installed.

## pama init (CHANGED)

`--mode local|remote` (interactive prompt when absent on a fresh install). In remote mode:
`--sync` enables sync for this project on the default server without prompting; otherwise asks.

## Global --server <url>

Selects a logged-in server for this command (remote mode semantics). Not logged in → exit 2.

## Remote-mode behaviour of existing commands

| Command | Remote mode |
|---|---|
| `capture drain` | drafts on device, queues the draft, delivers, pulls changes; never starts a local server |
| `review`, `link`, `inbox`, `reply`, `log` | same endpoints on the remote server with the device token |
| `sync status` | remote projects + device sync list + outbox counts |
| `sync enable/disable --project <key\|path>` | edits `remote.sync_projects`; disable queues a tombstone |
| `model show/check/switch` | server answering model (workspace scope); `--device` targets the drafting model stored on the device |
| `console` | opens a one-time sign-in link to the remote console |
| `doctor` | adds mode, servers, login validity, drafting model, pending deliveries |
| `server start/stop` | unchanged (local mode tooling) |
