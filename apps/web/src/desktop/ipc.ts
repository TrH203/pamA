// Typed wrappers for the desktop commands and events (contracts/desktop-ipc.md). The popup is
// served by the local server and talks to Rust only for capture, paste and settings.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CaptureResult {
  text: string | null;
  method: "ax" | "uia" | "clipboard" | "none";
  app?: string;
}

export interface SidecarStatus {
  running: boolean;
  url: string | null;
  port: number | null;
  token: string | null;
  mode: string;
  version: string;
}

export const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const ipc = {
  captureSelection: () => invoke<CaptureResult>("capture_selection"),
  pasteDraft: (text: string) => invoke<{ ok: boolean }>("paste_draft", { text }),
  copyDraft: (text: string) => invoke<{ ok: boolean }>("copy_draft", { text }),
  hidePopup: () => invoke<void>("hide_popup"),
  getPermissions: () => invoke<{ accessibility: "granted" | "denied" | "n/a" }>("get_permissions"),
  openPermissionSettings: () => invoke<void>("open_permission_settings"),
  setHotkey: (accelerator: string) =>
    invoke<{ ok: boolean; conflict: boolean; error?: string }>("set_hotkey", { accelerator }),
  sidecarStatus: () => invoke<SidecarStatus>("sidecar_status"),
  openConsole: (path?: string) => invoke<void>("open_console", { path }),
  setStrictOffline: (enabled: boolean, declaredHosts: string[]) =>
    invoke<{ ok: boolean }>("set_strict_offline", { enabled, declaredHosts }),
  setSync: (scope: "project" | "bundle", id: string, enabled: boolean | null, target?: string) =>
    invoke<{ ok: boolean }>("set_sync", { scope, id, enabled, target }),
  getSettings: () => invoke<Record<string, string | boolean | null>>("get_settings"),
  setSetting: (key: string, value: string) =>
    invoke<{ ok: boolean }>("set_setting", { key, value }),
  openSettings: () => invoke<void>("open_settings"),
  getNetworkLog: (limit = 200) =>
    invoke<
      {
        id: string;
        at: number;
        component: string;
        host: string;
        purpose: string;
        allowed: boolean;
      }[]
    >("get_network_log", { limit }),
};

export function onHotkey(
  fn: (e: { captured: CaptureResult; cursor: { x: number; y: number } }) => void,
): Promise<UnlistenFn> {
  return listen<{ captured: CaptureResult; cursor: { x: number; y: number } }>(
    "hotkey://triggered",
    (e) => fn(e.payload),
  );
}
