// Test harness for pipeline pages: an in-memory router with the console's routes, a fresh query
// client, the i18n/toast providers and a fetch stub answering by URL.
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
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { Home } from "../home/Home.tsx";
import { ActivityLayout } from "./ActivityLayout.tsx";
import { ActivityList, validateActivitySearch } from "./ActivityList.tsx";
import type { Run } from "./api.ts";
import { ReviewPipelineState } from "./ReviewPipelineState.tsx";
import { RunDetail } from "./RunDetail.tsx";

// jsdom: the router restores scroll on navigation; Radix Toast uses pointer capture on click.
if (typeof window !== "undefined") {
  window.scrollTo = (() => undefined) as typeof window.scrollTo;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
}

export function run(over: Partial<Run> = {}): Run {
  return {
    id: "01JC0000000000000000000001",
    kind: "transcript",
    agent: "claude_code",
    agent_session_id: "3f2a91c4-aaaa-bbbb",
    project_key: "pama",
    stage: "stored",
    status: "succeeded",
    error_code: null,
    error_message: null,
    role: null,
    provider: null,
    model: null,
    digest_id: null,
    attempts: 1,
    resumable: false,
    started_at: new Date(Date.now() - 120_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: new Date(Date.now() - 60_000).toISOString(),
    duration_ms: 60_000,
    ...over,
  };
}

export const counts = (over = {}) => ({
  running: 0,
  failed: 0,
  awaiting_review: 0,
  forwarded: 0,
  ...over,
});

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Stub fetch: the first matching [method+path prefix, handler] answers; others get 404. */
export function stubApi(routes: [string, Handler | unknown][]) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
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

function Blank() {
  return <p>elsewhere</p>;
}

export function renderAt(path: string): { router: AnyRouter; qc: QueryClient } {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = (p: string, component: () => React.JSX.Element | null) =>
    createRoute({ getParentRoute: () => root, path: p, component });
  const activity = page("/activity", ActivityLayout);
  const tree = root.addChildren([
    page("/", Home),
    page("/review", ReviewPipelineState),
    page("/links", Blank),
    page("/library/tasks", Blank),
    page("/settings/connections", Blank),
    activity.addChildren([
      createRoute({
        getParentRoute: () => activity,
        path: "/",
        component: ActivityList,
        validateSearch: validateActivitySearch,
      }),
      createRoute({ getParentRoute: () => activity, path: "audit", component: Blank }),
      createRoute({ getParentRoute: () => activity, path: "doctor", component: Blank }),
      createRoute({ getParentRoute: () => activity, path: "$id", component: RunDetail }),
    ]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
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
  return { router, qc };
}
