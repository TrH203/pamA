// Colour scheme: "system" follows prefers-color-scheme; "light"/"dark" pin it with
// <html data-theme>. The choice is a per-browser convenience, so storage failures are ignored.
import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "pama.theme";

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement) {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

/** Apply the saved theme before React renders (call once from each entry point). */
export function initTheme() {
  if (typeof document !== "undefined") applyTheme(readTheme());
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  useEffect(() => applyTheme(choice), [choice]);
  // Other windows (the desktop popup and settings) and tabs share the choice.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY || e.key === null) setChoice(readTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const set = useCallback((t: ThemeChoice) => {
    try {
      if (t === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* storage unavailable: the choice lasts for this page */
    }
    setChoice(t);
  }, []);
  return [choice, set];
}
