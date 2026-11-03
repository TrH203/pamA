// @vitest-environment jsdom
// Settings pages (spec 005 Connections/Devices, spec 007 Publish, Privacy, spec 008 Retention)
// against a stubbed API: loading/error/empty states, confirm gates and the bodies sent.
import { I18nProvider } from "@pama/i18n";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "@pama/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connections, Devices, Privacy, Publish, Retention, SettingsLayout } from "./index.ts";
import { shellQuote } from "./Publish.tsx";

if (typeof window !== "undefined") {
  window.scrollTo = (() => undefined) as typeof window.scrollTo;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubApi(routes: [string, Handler | unknown][]) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    for (const [key, h] of routes) {
      const [m, p] = key.includes(" ") ? key.split(" ") : ["GET", key];
      if (m === method && url.startsWith(p as string))
        return typeof h === "function" ? (h as Handler)(url, init) : Response.json(h);
    }
    return Response.json({ error: { code: "not_found", message: "nope" } }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const sent = (f: ReturnType<typeof stubApi>, method: string, path: string) =>
  f.mock.calls
    .filter(([u, i]) => (i?.method ?? "GET") === method && String(u).startsWith(path))
    .map(([, i]) => (i?.body ? JSON.parse(String(i.body)) : undefined));

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <I18nProvider initial="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

const show = (ui: JSX.Element) => render(<Providers>{ui}</Providers>);

const topology = (mode: "local" | "selfhost" | "cloud", extra: object = {}) => ({
  mode,
  baseUrl: mode === "local" ? "http://127.0.0.1:7465" : "https://srv.example",
  db: mode === "local" ? "pglite" : "pg",
  strictOffline: false,
  declaredHosts: [],
  components: [
    {
      id: "capture",
      name: "Capture",
      what: "Reads agent transcripts",
      movable: false,
      current: "device",
      detail: "On your machine.",
      options: [{ place: "device", how: "Always" }],
    },
  ],
  dataFlow: ["Nothing leaves this machine."],
  ...extra,
});

const role = (over: object = {}) => ({
  provider: "ollama",
  preset: "ollama",
  model: "qwen3:14b",
  base_url: "http://127.0.0.1:11434",
  key_set: false,
  local: true,
  verified: true,
  origin: "env",
  scope: "server",
  ...over,
});
const effective = {
  strict_offline: false,
  roles: {
    chat: role({ origin: "saved" }),
    small: role({ model: "qwen3:8b" }),
    embed: role({ model: "bge-m3", origin: "default" }),
  },
};
const settingsView = (tenant = false) => ({
  strict_offline: false,
  roles: Object.fromEntries(
    ["chat", "small", "embed"].map((r) => [
      r,
      {
        provider: "ollama",
        model: "m",
        keySet: false,
        local: true,
        verified: true,
        source: "env",
        ...(tenant ? { scope: "server" } : {}),
        ...(r === "chat" ? { lastCheck: { ok: true, latencyMs: 42, items: [] } } : {}),
      },
    ]),
  ),
});

describe("Connections", () => {
  it("shows where the data lives and each role with its origin and last check", async () => {
    stubApi([
      ["/v1/settings/topology", topology("local")],
      ["/v1/models/effective", effective],
      ["/v1/models/settings", settingsView()],
    ]);
    show(<Connections />);
    expect(await screen.findByText("On this machine", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:7465")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("From env")).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("Passed in 42 ms")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change: Embedding" })).toBeTruthy();
  });

  it("asks before data leaves, then saves with that confirmation", async () => {
    const fetch = stubApi([
      ["/v1/settings/topology", topology("local")],
      ["/v1/models/effective", effective],
      ["/v1/models/settings", settingsView()],
      [
        "PUT /v1/models/settings/chat",
        (_u: string, init?: RequestInit) => {
          const b = JSON.parse(String(init?.body));
          if (!b.confirm.includes("data_leaves"))
            return Response.json(
              {
                error: { code: "confirmation_required", message: "needs ok" },
                required: ["data_leaves"],
              },
              { status: 409 },
            );
          return Response.json({ check: { ok: true, latencyMs: 5, items: [] } });
        },
      ],
    ]);
    show(<Connections />);
    await userEvent.click(await screen.findByRole("button", { name: "Change: Chat" }));
    const dialog = await screen.findByRole("dialog", { name: "Change the Chat model" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Provider"), "openrouter");
    // A provider switch suggests its model from the shared registry.
    expect((within(dialog).getByLabelText("Model") as HTMLInputElement).value).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    await userEvent.clear(within(dialog).getByLabelText("Model"));
    await userEvent.type(within(dialog).getByLabelText("Model"), "openai/gpt-5-mini");
    await userEvent.type(within(dialog).getByLabelText(/API key/), "sk-or-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    const gate = await screen.findByRole("alertdialog", { name: "Confirm this change" });
    expect(within(gate).getByText(/Data leaves this server/)).toBeTruthy();
    await userEvent.click(within(gate).getByRole("button", { name: "Confirm and save" }));
    await waitFor(() => expect(sent(fetch, "PUT", "/v1/models/settings/chat")).toHaveLength(2));
    expect(sent(fetch, "PUT", "/v1/models/settings/chat")[1]).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-5-mini",
      apiKey: "sk-or-1",
      confirm: ["data_leaves"],
    });
  });

  it("lets a cloud workspace owner change only the chat model", async () => {
    stubApi([
      ["/v1/settings/topology", topology("cloud")],
      ["/v1/models/effective", effective],
      ["/v1/models/settings", settingsView(true)],
    ]);
    show(<Connections />);
    expect(await screen.findByRole("button", { name: "Change: Chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change: Small" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check: Embedding" })).toBeNull();
    expect(screen.getAllByText("Set by the server operator.")).toHaveLength(2);
  });

  it("shows an error with retry when the server cannot be reached", async () => {
    const fetch = stubApi([
      [
        "/v1/settings/topology",
        () => Response.json({ error: { code: "x", message: "boom" } }, { status: 500 }),
      ],
      ["/v1/models/effective", effective],
      ["/v1/models/settings", settingsView()],
    ]);
    show(<Connections />);
    expect(await screen.findByText("boom")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([u]) => u === "/v1/settings/topology").length).toBe(2),
    );
  });
});

describe("Devices", () => {
  const devices = {
    items: [
      {
        id: "d1",
        name: "hien-mbp",
        last_seen_at: new Date().toISOString(),
        revoked_at: null,
        created_at: "2026-10-01T00:00:00Z",
      },
      {
        id: "d2",
        name: "old-laptop",
        last_seen_at: null,
        revoked_at: "2026-10-02T00:00:00Z",
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
  };

  it("lists devices, revokes after confirming and shows the pairing command", async () => {
    const fetch = stubApi([
      ["/v1/settings/topology", topology("selfhost")],
      ["/v1/devices", devices],
      ["POST /v1/devices/d1/revoke", () => new Response(null, { status: 204 })],
      ["POST /v1/devices/pairing-code", { code: "ABCD-EFGH", expires_at: "2026-11-03T10:00:00Z" }],
    ]);
    show(<Devices />);
    expect(await screen.findByText("hien-mbp")).toBeTruthy();
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke old-laptop" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Revoke hien-mbp" }));
    const dlg = await screen.findByRole("alertdialog", { name: 'Revoke "hien-mbp"?' });
    await userEvent.click(within(dlg).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(sent(fetch, "POST", "/v1/devices/d1/revoke")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByText("pama connect https://srv.example --code ABCD-EFGH")).toBeTruthy();
  });

  it("shows an empty state without devices", async () => {
    stubApi([
      ["/v1/settings/topology", topology("cloud")],
      ["/v1/devices", { items: [] }],
    ]);
    show(<Devices />);
    expect(await screen.findByText("No devices yet")).toBeTruthy();
  });

  it("explains local mode instead of offering a pairing code", async () => {
    stubApi([["/v1/settings/topology", topology("local")]]);
    show(<Devices />);
    expect(await screen.findByText("This machine is its own server")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create pairing code" })).toBeNull();
  });
});

const task = (over: object = {}) => ({
  id: "b1",
  project_id: "p1",
  name: "Refunds",
  key: "feat/refunds",
  sync_enabled: null,
  branches: ["feat/refunds"],
  session_count: 3,
  last_activity: null,
  ...over,
});
const project = (over: object = {}) => ({
  id: "p1",
  name: "shop",
  repo_key: "github.com/acme/shop",
  sync_enabled: true,
  sync_target: "https://cloud.example",
  bundles: [task()],
  ...over,
});

describe("Publish (local mode)", () => {
  it("warns before turning a project off and lists the CLI check", async () => {
    const fetch = stubApi([
      ["/v1/settings/topology", topology("local")],
      ["/v1/sync/status", { projects: [project()], pending: { digests: 2, tombstones: 0 } }],
      ["/v1/sync/source", { target: "https://cloud.example", source_type: "project" }],
      ["PATCH /v1/projects/p1", { id: "p1" }],
    ]);
    show(<Publish />);
    expect(await screen.findByText(/Publish is one-way/)).toBeTruthy();
    expect(screen.getByText("Waiting to send: 2 digests, 0 deletions.")).toBeTruthy();
    expect(screen.getByText("pama sync now")).toBeTruthy();

    await userEvent.click(screen.getByRole("switch", { name: "Publish shop" }));
    const dlg = await screen.findByRole("alertdialog", { name: 'Stop publishing "shop"?' });
    expect(within(dlg).getByText(/copies on https:\/\/cloud.example are deleted/)).toBeTruthy();
    expect(within(dlg).getByText("pama sync disable --project p1")).toBeTruthy();
    await userEvent.click(within(dlg).getByRole("button", { name: "Stop publishing" }));
    await waitFor(() =>
      expect(sent(fetch, "PATCH", "/v1/projects/p1")).toEqual([{ sync_enabled: false }]),
    );
  });

  it("does not change anything when the warning is cancelled", async () => {
    const fetch = stubApi([
      ["/v1/settings/topology", topology("local")],
      ["/v1/sync/status", { projects: [project()], pending: { digests: 0, tombstones: 0 } }],
      ["/v1/sync/source", { target: "https://cloud.example" }],
    ]);
    show(<Publish />);
    await userEvent.click(await screen.findByRole("switch", { name: "Publish task Refunds" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText("pama sync disable --task b1")).toBeTruthy();
    await userEvent.click(within(dlg).getAllByRole("button", { name: "Cancel" })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sent(fetch, "PATCH", "/v1/bundles/b1")).toEqual([]);
  });

  it("names the task by id in the CLI command, never by a name the shell could run", async () => {
    stubApi([
      ["/v1/settings/topology", topology("local")],
      [
        "/v1/sync/status",
        {
          projects: [project({ bundles: [task({ name: "fix $(curl x|sh)" })] })],
          pending: { digests: 0, tombstones: 0 },
        },
      ],
      ["/v1/sync/source", { target: "https://cloud.example" }],
    ]);
    show(<Publish />);
    await userEvent.click(
      await screen.findByRole("switch", { name: "Publish task fix $(curl x|sh)" }),
    );
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText("pama sync disable --task b1")).toBeTruthy();
    expect(within(dlg).queryByText(/curl/, { selector: "code" })).toBeNull();
  });

  it("quotes shell arguments POSIX-style", () => {
    expect(shellQuote("b1")).toBe("b1");
    expect(shellQuote("fix $(x) `y` $HOME")).toBe("'fix $(x) `y` $HOME'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("says when it is connected but nothing is published, and turns a task on", async () => {
    const fetch = stubApi([
      ["/v1/settings/topology", topology("local")],
      [
        "/v1/sync/status",
        { projects: [project({ sync_enabled: false })], pending: { digests: 0, tombstones: 0 } },
      ],
      ["PATCH /v1/bundles/b1", { id: "b1" }],
    ]);
    show(<Publish />);
    expect(await screen.findByText(/nothing is published yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "Publish task Refunds" }));
    await waitFor(() =>
      expect(sent(fetch, "PATCH", "/v1/bundles/b1")).toEqual([{ sync_enabled: true }]),
    );
  });

  it("shows how to connect when no server is configured", async () => {
    stubApi([
      ["/v1/settings/topology", topology("local")],
      [
        "/v1/sync/status",
        {
          projects: [project({ sync_enabled: false, sync_target: null })],
          pending: { digests: 0, tombstones: 0 },
        },
      ],
    ]);
    show(<Publish />);
    expect(await screen.findByText("Not connected to a server")).toBeTruthy();
    expect(screen.getByText("pama connect <url>")).toBeTruthy();
  });
});

describe("Sharing (server mode)", () => {
  it("warns when machines are connected but nothing was shared", async () => {
    stubApi([
      ["/v1/settings/topology", topology("cloud")],
      ["/v1/projects", { items: [] }],
      [
        "/v1/devices",
        {
          items: [
            { id: "d", name: "m", last_seen_at: null, revoked_at: null, created_at: "2026-10-01" },
          ],
        },
      ],
    ]);
    show(<Publish />);
    expect(await screen.findByText("Nothing has been shared with this server yet")).toBeTruthy();
    expect(screen.getByText("pama sync enable --project <name>")).toBeTruthy();
  });
});

describe("Privacy", () => {
  it("shows strict offline read-only with the commands to change it", async () => {
    stubApi([
      [
        "/v1/settings/topology",
        topology("local", { strictOffline: true, declaredHosts: ["openrouter.ai"] }),
      ],
    ]);
    show(<Privacy />);
    expect(await screen.findByText("openrouter.ai")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.getByText("pama config set strict_offline false")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Nothing leaves this machine.")).toBeTruthy();
  });
});

describe("Retention", () => {
  it("validates and saves the number of days", async () => {
    const fetch = stubApi([
      ["/v1/settings/retention", { ask_retention_days: 180 }],
      ["PUT /v1/settings/retention", { ask_retention_days: 30 }],
    ]);
    show(<Retention />);
    const input = await screen.findByLabelText("Keep conversations for (days)");
    await userEvent.clear(input);
    await userEvent.type(input, "0");
    expect(screen.getByText("Enter a whole number from 1 to 3650.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(input);
    await userEvent.type(input, "30");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent(fetch, "PUT", "/v1/settings/retention")).toEqual([{ ask_retention_days: 30 }]),
    );
  });
});

describe("Settings layout", () => {
  function renderAt(path: string) {
    const root = createRootRoute({ component: () => <Outlet /> });
    const settings = createRoute({
      getParentRoute: () => root,
      path: "/settings",
      component: SettingsLayout,
    });
    const tree = root.addChildren([
      settings.addChildren([
        createRoute({ getParentRoute: () => settings, path: "privacy", component: Privacy }),
        createRoute({
          getParentRoute: () => settings,
          path: "retention",
          component: Retention,
        }),
      ]),
    ]);
    const router = createRouter({
      routeTree: tree,
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    return render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
  }

  it("names the publish page Sharing on a server and marks the current page", async () => {
    stubApi([
      ["/v1/auth/me", { mode: "cloud" }],
      ["/v1/settings/retention", { ask_retention_days: 180 }],
    ]);
    renderAt("/settings/retention");
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    expect(await within(nav).findByRole("link", { name: "Sharing" })).toBeTruthy();
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "Retention" }).getAttribute("data-status")).toBe(
        "active",
      ),
    );
  });
});
