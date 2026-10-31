// Shared EN/VI strings for the console, the desktop windows and the Ask page (spec 009).
// The locale is the viewer's saved choice, else the browser language; <html lang> follows it.
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { en, type Messages } from "./en.ts";
import { vi } from "./vi.ts";

export type { Messages } from "./en.ts";
export type Locale = "en" | "vi";
export const LOCALES: readonly Locale[] = ["en", "vi"];
const KEY = "pama.lang";

const MESSAGES: Record<Locale, Messages> = { en, vi };

export function messages(locale: Locale): Messages {
  return MESSAGES[locale];
}

export function isLocale(v: unknown): v is Locale {
  return v === "en" || v === "vi";
}

/** Saved choice, else the first supported browser language, else English. */
export function detectLocale(
  langs: readonly string[] = typeof navigator === "undefined"
    ? []
    : (navigator.languages ?? [navigator.language]),
): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  for (const l of langs) {
    const base = l?.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return "en";
}

function persist(locale: Locale) {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    /* storage unavailable: the choice lasts for this page */
  }
}

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Messages;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, set] = useState<Locale>(() => initial ?? detectLocale());
  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    persist(l);
    set(l);
  }, []);
  const value = useMemo(() => ({ locale, setLocale, t: MESSAGES[locale] }), [locale, setLocale]);
  return createElement(I18nContext.Provider, { value }, children);
}

/** Strings for the current locale. Outside a provider it falls back to the detected locale. */
export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  const locale = detectLocale();
  return { locale, setLocale: persist, t: MESSAGES[locale] };
}
