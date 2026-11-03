// @vitest-environment jsdom
// Review fixes for spec 009: Doctor re-run, search parsing, landmarks, cross-window sync.
import { I18nProvider, useI18n } from "@pama/i18n";
import { Table, ToastProvider, useTheme } from "@pama/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Doctor } from "./Doctor.tsx";
import { searchText } from "./router.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const report = (detail: string) => ({
  ok: true,
  at: Date.now(),
  checks: [{ check: "daemon", ok: true, detail, fix: null }],
  captures: { total: 0, byStatus: {}, recent: [] },
  scan: null,
  outbox: { pending: 0, failed: 0 },
});

function renderDoctor(qc: QueryClient) {
  return render(
    <I18nProvider initial="en">
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <Doctor />
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("Doctor re-run", () => {
  it("always requests a fresh report, even when the cached one is fresh", async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(report(url.includes("fresh=1") ? "fresh" : "cached")),
    );
    vi.stubGlobal("fetch", fetch);
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: 15_000, retry: false } },
    });
    qc.setQueryData(["doctor"], report("cached"));
    renderDoctor(qc);
    expect(await screen.findByText("cached")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /re-run/i }));
    expect(await screen.findByText("fresh")).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => String(u).includes("/v1/doctor?fresh=1"))).toBe(true);
  });

  it("shows an error when the re-run fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "x", message: "boom" } }, { status: 500 })),
    );
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: 15_000, retry: false } },
    });
    qc.setQueryData(["doctor"], report("cached"));
    renderDoctor(qc);
    await userEvent.click(screen.getByRole("button", { name: /re-run/i }));
    expect(await screen.findByText("boom")).toBeTruthy();
    expect(screen.getByText("cached")).toBeTruthy();
  });
});

describe("searchText", () => {
  it("keeps values the router parsed as numbers or booleans", () => {
    expect(searchText("hello")).toBe("hello");
    expect(searchText(123)).toBe("123");
    expect(searchText(true)).toBe("true");
    expect(searchText("")).toBeUndefined();
    expect(searchText({ a: 1 })).toBeUndefined();
    expect(searchText(undefined)).toBeUndefined();
  });
});

describe("Table", () => {
  it("is keyboard focusable so it can scroll sideways", () => {
    render(<Table label="Rows" />);
    expect(screen.getByRole("region", { name: "Rows" }).tabIndex).toBe(0);
  });
});

function storage(key: string, newValue: string | null) {
  localStorage.setItem(key, newValue ?? "");
  if (newValue === null) localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

function ThemeProbe() {
  const [theme] = useTheme();
  return <span data-testid="theme">{theme}</span>;
}

function LangProbe() {
  const { locale } = useI18n();
  return <span data-testid="lang">{locale}</span>;
}

describe("cross-window sync", () => {
  it("follows a theme change made in another window", () => {
    render(<ThemeProbe />);
    expect(screen.getByTestId("theme").textContent).toBe("system");
    act(() => storage("pama.theme", "dark"));
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    act(() => storage("pama.theme", null));
    expect(screen.getByTestId("theme").textContent).toBe("system");
  });

  it("follows a language change made in another window", async () => {
    render(
      <I18nProvider initial="en">
        <LangProbe />
      </I18nProvider>,
    );
    act(() => storage("pama.lang", "vi"));
    await waitFor(() => expect(screen.getByTestId("lang").textContent).toBe("vi"));
    expect(document.documentElement.lang).toBe("vi");
  });
});
