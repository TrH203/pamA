# Desktop IPC Contract: pamA Desktop (Tauri 2)

Commands are invoked from the webview (`invoke`); events are emitted by Rust. Types are generated
into `packages/types`. There is deliberately **no command that sends a message** to any external
application (Constitution III).

## Commands (webview → Rust)

| Command | Args | Returns | Notes |
|---|---|---|---|
| `capture_selection` | — | `{text: string \| null, method: "ax" \| "uia" \| "clipboard" \| "none", app?: string}` | Snapshots and restores clipboard (FR-022) |
| `paste_draft` | `{text}` | `{ok: bool}` | Writes draft, simulates paste into previously focused app, restores clipboard after 500 ms. Never presses Enter |
| `copy_draft` | `{text}` | `{ok}` | Leaves draft on clipboard (explicit user choice) |
| `get_permissions` | — | `{accessibility: "granted" \| "denied" \| "n/a"}` | macOS only meaningful |
| `open_permission_settings` | — | — | Deep-links to System Settings › Privacy › Accessibility |
| `set_hotkey` | `{accelerator}` | `{ok, conflict?: bool}` | |
| `sidecar_status` | — | `{running, port, mode, version}` | |
| `set_sync` | `{scope: "project" \| "bundle", id, enabled, target?}` | `{ok}` | Proxies to server; disabling queues tombstone |
| `set_strict_offline` | `{enabled, declared_hosts[]}` | `{ok}` | Applies to Rust clients and sidecar |
| `get_network_log` | `{limit}` | `NetworkLogEntry[]` | |

All draft generation, links and inbox calls go from the webview to the local sidecar HTTP API
(`http://127.0.0.1:<port>/v1`, per-launch token), not through Rust.

## Events (Rust → webview)

| Event | Payload |
|---|---|
| `hotkey://triggered` | `{captured: CaptureResult, cursor: {x, y}}` |
| `inbox://new` | `{count, latest_ask_id}` (also shown as OS notification) |
| `review://new` | `{count}` |
| `sidecar://state` | `{running, error?}` |

## Popup actions (UI contract)

Copy · Paste · Shorter · Edit · Change scope · Create Ask Link (pre-filled with question and
suggested sources). Closing the popup never alters the clipboard unless Copy was chosen.
