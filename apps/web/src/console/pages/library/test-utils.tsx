// Test harness for the Library and Review pages: an in-memory router with their routes, a fresh
// query client, the app providers and a fetch stub answering by method and URL.
import { I18nProvider } from "@pama/i18n";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "@pama/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { type RenderResult, render } from "@testing-library/react";
import type { JSX } from "react";
import { type Mock, vi } from "vitest";
import { Review } from "../review/Review.tsx";
import { Digests } from "./Digests.tsx";
import { LibraryLayout } from "./Library.tsx";
import { SearchResults } from "./SearchResults.tsx";
import { SessionDetailRoute } from "./SessionDetail.tsx";
import { Sessions } from "./Sessions.tsx";
import { TaskDetailRoute } from "./TaskDetail.tsx";
import { Tasks } from "./Tasks.tsx";

// jsdom: the router restores scroll on navigation; Radix uses pointer capture on click.
if (typeof window !== "undefined") {
  window.scrollTo = (() => undefined) as typeof window.scrollTo;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  // Radix Switch measures itself.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
export type FetchMock = Mock<(input: string, init?: RequestInit) => Promise<Response>>;

/** Stub fetch: the first matching ["METHOD /path-prefix", handler|json] answers; others 404. */
export function stubApi(routes: [string, Handler | unknown][]): FetchMock {
  const fetch: FetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    for (const [key, h] of routes) {
      const [m, p] = key.includes(" ") ? key.split(" ") : ["GET", key];
      if (m === method && url.startsWith(p as string)) {
        return typeof h === "function" ? (h as Handler)(url, init) : Response.json(h);
      }
    }
    return Response.json({ error: { code: "not_found", message: "nope" } }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The parsed JSON bodies sent to `path` with `method` (undefined for bodiless requests). */
export function sent(fetch: FetchMock, method: string, path: string): unknown[] {
  return fetch.mock.calls
    .filter(([u, i]) => (i?.method ?? "GET") === method && String(u).startsWith(path))
    .map(([, i]) => (i?.body ? JSON.parse(String(i.body)) : undefined));
}

/** The GET URLs requested under `path`. */
export function gets(fetch: FetchMock, path: string): string[] {
  return fetch.mock.calls
    .filter(([u, i]) => (i?.method ?? "GET") === "GET" && String(u).startsWith(path))
    .map(([u]) => String(u));
}

const searchText = (v: unknown) =>
  typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined;

function Blank() {
  return <p>elsewhere</p>;
}

export function renderAt(path: string): RenderResult & { router: AnyRouter; qc: QueryClient } {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = (p: string, component: () => JSX.Element | null) =>
    createRoute({ getParentRoute: () => root, path: p, component });
  const library = page("/library", LibraryLayout);
  const child = (p: string, component: () => JSX.Element | null) =>
    createRoute({ getParentRoute: () => library, path: p, component });
  const tree = root.addChildren([
    page("/review", Review),
    library.addChildren([
      child("tasks", Tasks),
      child("tasks/$id", TaskDetailRoute),
      child("sessions", Sessions),
      child("sessions/$id", SessionDetailRoute),
      child("digests", Digests),
      createRoute({
        getParentRoute: () => library,
        path: "search",
        component: SearchResults,
        validateSearch: (s: Record<string, unknown>): { q?: string } =>
          searchText(s.q) !== undefined ? { q: searchText(s.q) } : {},
      }),
    ]),
    page("/links", Blank),
    page("/activity", Blank),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <I18nProvider initial="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              <RouterProvider router={router} />
            </ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...utils, router, qc };
}
