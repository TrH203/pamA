// Test harness for the Conversations and Chat pages: an in-memory router with their routes, a
// fresh query client, the app providers and a fetch stub answering by method and URL.
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
import type { JSX } from "react";
import { vi } from "vitest";
import { ChatPage, chatSearch } from "../chat/ChatPage.tsx";
import { ConversationDetailPage } from "./ConversationDetail.tsx";
import { ConversationsPage, conversationSearch } from "./ConversationsPage.tsx";

// jsdom: the router restores scroll on navigation; Radix uses pointer capture on click.
if (typeof window !== "undefined") {
  window.scrollTo = (() => undefined) as typeof window.scrollTo;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Stub fetch: the first matching ["METHOD /path-prefix", handler|json] answers; others 404. */
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

/** The parsed JSON bodies sent to `path` with `method`. */
export function sent(fetch: ReturnType<typeof stubApi>, method: string, path: string): unknown[] {
  return fetch.mock.calls
    .filter(([u, i]) => (i?.method ?? "GET") === method && String(u).startsWith(path))
    .map(([, i]) => (i?.body ? JSON.parse(String(i.body)) : undefined));
}

function Blank() {
  return <p>elsewhere</p>;
}

export function renderAt(path: string): { router: AnyRouter; qc: QueryClient } {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = (p: string, component: () => JSX.Element | null) =>
    createRoute({ getParentRoute: () => root, path: p, component });
  const tree = root.addChildren([
    createRoute({
      getParentRoute: () => root,
      path: "/conversations",
      component: ConversationsPage,
      validateSearch: conversationSearch,
    }),
    page("/conversations/$id", ConversationDetailPage),
    createRoute({
      getParentRoute: () => root,
      path: "/chat",
      component: ChatPage,
      validateSearch: chatSearch,
    }),
    page("/library/search", Blank),
    page("/links", Blank),
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
