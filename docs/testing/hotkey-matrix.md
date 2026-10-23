# Hotkey manual test matrix (quickstart Scenario 3)

Automated tests cover the clipboard logic (`crates/pama-desktop/src-tauri/tests/clipboard.rs`)
and the draft API (`apps/server/tests/integration/draft.test.ts`). Selection capture and paste
depend on each OS and app, so they are checked by hand before every release.

## Setup

1. Build the sidecar and run the app: `scripts/build-sidecar.sh && cargo run -p pama-desktop`
   (or install the release build).
2. macOS: grant **Accessibility** when prompted (System Settings › Privacy & Security ›
   Accessibility). Windows: run the target apps without elevation (UIPI blocks input into
   elevated windows).
3. Have at least one approved digest (`pama review --approve <id>`).
4. Default hotkey: **Cmd/Ctrl + Shift + Space** (change it in Settings).

## Steps per app

| # | Step | Expected |
|---|---|---|
| 1 | Copy `CLIPBOARD-SENTINEL` anywhere | — |
| 2 | Select a question in the app, press the hotkey | Popup at the cursor within 3 s with the question, a cited draft and a suggested scope |
| 3 | Choose **Paste** | Draft appears in the app's input field; **nothing is sent** |
| 4 | Press Cmd/Ctrl+V in another field | `CLIPBOARD-SENTINEL` is pasted (clipboard restored) |
| 5 | Select nothing, press the hotkey | Popup opens with an empty question box |
| 6 | Choose **Create Ask Link** | Console opens on Links with the question pre-filled |
| 7 | Choose **Copy** | Draft is on the clipboard (explicit choice) |

## Matrix

Mark each cell ✅ / ❌ with notes on capture method (AX/UIA/clipboard).

| App | macOS 13+ | macOS 15 | Windows 10 | Windows 11 |
|---|---|---|---|---|
| Zalo (desktop) | | | | |
| Slack (desktop) | | | | |
| Microsoft Teams | | | | |
| Chrome (Gmail web) | | | | |
| Outlook | | | | |
| Telegram | | | | |
| Messenger (web) | | | | |

## Known limits

- Exotic or app-private clipboard formats (RTF, app-specific) cannot be restored; text, HTML,
  images and file lists are.
- Some apps disable Accessibility selection (password fields, protected apps): capture falls back
  to the clipboard, or the popup opens empty.
- Windows: UI Automation code is compiled on the Windows CI runner only (cross-compiling from macOS
  fails in `aws-lc-sys`).
