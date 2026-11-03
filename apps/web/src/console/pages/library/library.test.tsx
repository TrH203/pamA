// @vitest-environment jsdom
// Library pages (spec 007): tasks (rename, merge, split), sessions, session detail actions,
// digests filters and search grouped by task.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bundle, SearchHit, SessionDetail } from "./data.ts";
import { diffDigests, hasChanges } from "./diff.ts";
import { groupByTask } from "./SearchResults.tsx";
import { gets, renderAt, sent, stubApi } from "./test-utils.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session = (id: string, agent = "claude_code", branches = ["feat/retry"]) => ({
  id,
  agent,
  agent_session_id: `${id}-abcdef123456`,
  ended_at: "2026-10-30T10:00:00Z",
  branches,
  bundle_pinned: false,
});

const bundles: Bundle[] = [
  {
    id: "b1",
    name: "Retry payments",
    name_source: "suggested",
    key: "feat/retry",
    project: "shop",
    project_id: "p1",
    branches: ["feat/retry", "fix/retry-2"],
    session_count: 2,
    last_activity: "2026-10-30T10:00:00Z",
    sessions: [session("s1"), session("s2", "codex", ["fix/retry-2"])],
  },
  {
    id: "b2",
    name: "Checkout copy",
    name_source: "key",
    key: "copy",
    project: "shop",
    project_id: "p1",
    branches: ["copy"],
    session_count: 1,
    last_activity: null,
    sessions: [session("s3", "cursor", ["copy"])],
  },
  {
    id: "b3",
    name: "Docs site",
    name_source: "owner",
    key: null,
    project: "docs",
    project_id: "p2",
    branches: [],
    session_count: 1,
    last_activity: null,
    sessions: [session("s4", "opencode", [])],
  },
];

const syncStatus = {
  projects: [
    {
      id: "p1",
      sync_enabled: true,
      sync_target: "https://team.example",
      bundles: [
        { id: "b1", sync_enabled: null },
        { id: "b2", sync_enabled: false },
      ],
    },
    {
      id: "p2",
      sync_enabled: false,
      sync_target: null,
      bundles: [{ id: "b3", sync_enabled: null }],
    },
  ],
  pending: { digests: 0, tombstones: 0 },
};

describe("Tasks tab", () => {
  it("explains Task, groups by project and shows branches, counts and publish state", async () => {
    stubApi([
      ["/v1/bundles", { items: bundles }],
      ["/v1/sync/status", syncStatus],
    ]);
    renderAt("/library/tasks");
    expect(await screen.findByText("Retry payments")).toBeTruthy();
    expect(
      screen.getByText(/A task groups the agent sessions about one piece of work/),
    ).toBeTruthy();
    const shop = screen.getByRole("region", { name: "shop" });
    expect(within(shop).getByText("fix/retry-2")).toBeTruthy();
    expect(within(shop).getByText("2 sessions")).toBeTruthy();
    expect(within(shop).getAllByText("Published")).toHaveLength(2); // header + b1
    expect(within(shop).getByText("Not published")).toBeTruthy();
    expect(screen.getByRole("region", { name: "docs" })).toBeTruthy();
  });

  it("hides the publish column when the server has no publish (cloud mode)", async () => {
    stubApi([["/v1/bundles", { items: bundles }]]);
    renderAt("/library/tasks");
    await screen.findByText("Retry payments");
    expect(screen.queryByText("Published")).toBeNull();
    expect(screen.queryByText("Not published")).toBeNull();
  });

  it("renames a task in place", async () => {
    const fetch = stubApi([
      ["/v1/bundles", { items: bundles }],
      ["PATCH /v1/bundles/b1", { id: "b1", name: "Retries" }],
    ]);
    renderAt("/library/tasks");
    await userEvent.click(await screen.findByRole("button", { name: "Rename: Retry payments" }));
    const input = screen.getByRole("textbox", { name: "New name for Retry payments" });
    await userEvent.clear(input);
    await userEvent.type(input, "Retries{Enter}");
    await waitFor(() =>
      expect(sent(fetch, "PATCH", "/v1/bundles/b1")).toEqual([{ name: "Retries" }]),
    );
  });

  it("Escape cancels a rename without saving", async () => {
    const fetch = stubApi([["/v1/bundles", { items: bundles }]]);
    renderAt("/library/tasks");
    await userEvent.click(await screen.findByRole("button", { name: "Rename: Retry payments" }));
    await userEvent.type(screen.getByRole("textbox", { name: /New name/ }), "x{Escape}");
    expect(screen.queryByRole("textbox", { name: /New name/ })).toBeNull();
    expect(sent(fetch, "PATCH", "/v1/bundles")).toEqual([]);
  });

  it("merges selected tasks of one project after confirming", async () => {
    const fetch = stubApi([
      ["/v1/bundles", { items: bundles }],
      ["POST /v1/bundles/merge", { id: "b1" }],
    ]);
    renderAt("/library/tasks");
    const merge = await screen.findByRole("button", { name: /Merge \(0\)/ });
    expect((merge as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Retry payments" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Checkout copy" }));
    await userEvent.click(screen.getByRole("button", { name: /Merge \(2\)/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Merge 2 tasks?" });
    const name = within(dialog).getByRole("textbox", { name: "Name of the merged task" });
    expect((name as HTMLInputElement).value).toBe("Retry payments");
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() =>
      expect(sent(fetch, "POST", "/v1/bundles/merge")).toEqual([
        { bundle_ids: ["b1", "b2"], name: "Retry payments" },
      ]),
    );
  });

  it("will not merge tasks from different projects", async () => {
    stubApi([["/v1/bundles", { items: bundles }]]);
    renderAt("/library/tasks");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Retry payments" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Docs site" }));
    expect(screen.getByText("Pick tasks from one project to merge them.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Merge \(2\)/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows an empty state and an error with retry", async () => {
    stubApi([["/v1/bundles", { items: [] }]]);
    renderAt("/library/tasks");
    expect(await screen.findByText("No tasks yet")).toBeTruthy();
    cleanup();
    let calls = 0;
    stubApi([
      [
        "/v1/bundles",
        () =>
          ++calls === 1
            ? Response.json({ error: { code: "x", message: "db down" } }, { status: 500 })
            : Response.json({ items: bundles }),
      ],
    ]);
    renderAt("/library/tasks");
    expect(await screen.findByText("db down")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Retry payments")).toBeTruthy();
  });
});

describe("Task detail", () => {
  it("splits picked sessions into a new task", async () => {
    const fetch = stubApi([
      ["/v1/bundles", { items: bundles }],
      ["POST /v1/bundles/b1/split", { id: "b9" }],
    ]);
    const { router } = renderAt("/library/tasks/b1");
    expect(await screen.findByText("Retry payments")).toBeTruthy();
    const split = screen.getByRole("button", { name: "Split" });
    expect((split as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select s2-abcde" }));
    await userEvent.click(split);
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Name of the new task" }),
      "Retry v2{Enter}",
    );
    await waitFor(() =>
      expect(sent(fetch, "POST", "/v1/bundles/b1/split")).toEqual([
        { session_ids: ["s2"], new_name: "Retry v2" },
      ]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/library/tasks/b9"));
  });

  it("says when the task no longer exists", async () => {
    stubApi([["/v1/bundles", { items: bundles }]]);
    renderAt("/library/tasks/gone");
    expect(await screen.findByText("This task no longer exists")).toBeTruthy();
  });
});

const sessionRow = {
  id: "s1",
  agent: "codex",
  agent_session_id: "s1-abcdef123456",
  started_at: "2026-10-30T09:00:00Z",
  ended_at: "2026-10-30T10:00:00Z",
  bundle_pinned: false,
  project_id: "p1",
  project: "shop",
  bundle_id: "b1",
  bundle: "Retry payments",
  status: "approved",
  goal: "Add retries to the payment client",
  versions: 2,
  branches: ["feat/retry"],
};

describe("Sessions tab", () => {
  it("lists sessions with agent, status and task, and filters by agent", async () => {
    const fetch = stubApi([
      ["/v1/projects", { items: [{ id: "p1", name: "shop", repo_key: "x", auto_approve: null }] }],
      ["/v1/sessions", { items: [sessionRow], total: 1, limit: 50, offset: 0, next_offset: null }],
    ]);
    renderAt("/library/sessions");
    const link = await screen.findByRole("link", { name: "Add retries to the payment client" });
    expect(link.getAttribute("href")).toBe("/library/sessions/s1");
    const table = screen.getByRole("table");
    expect(within(table).getByText("Codex")).toBeTruthy();
    expect(within(table).getByText("Approved")).toBeTruthy();
    expect(screen.getByText("2 versions")).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Agent" }), "cursor");
    await waitFor(() =>
      expect(gets(fetch, "/v1/sessions").some((u) => u.includes("agent=cursor"))).toBe(true),
    );
  });

  it("shows the empty state", async () => {
    stubApi([
      ["/v1/projects", { items: [] }],
      ["/v1/sessions", { items: [], total: 0, limit: 50, offset: 0, next_offset: null }],
    ]);
    renderAt("/library/sessions");
    expect(await screen.findByText("No sessions")).toBeTruthy();
  });
});

const detail: SessionDetail = {
  id: "s1",
  agent: "claude_code",
  agent_session_id: "s1-abcdef123456",
  started_at: "2026-10-30T09:00:00Z",
  ended_at: "2026-10-30T10:00:00Z",
  bundle_pinned: false,
  created_at: "2026-10-30T10:01:00Z",
  project_id: "p1",
  project: "shop",
  project_key: "github.com/acme/shop",
  bundle_id: "b1",
  bundle: "Retry payments",
  status: "approved",
  branches: [{ name: "feat/retry", first_seen_at: null, last_seen_at: null, event_count: 12 }],
  digests: [
    {
      id: "d2",
      version: 2,
      status: "approved",
      created_at: "2026-10-30T11:00:00Z",
      approved_at: "2026-10-30T11:00:00Z",
      model: "claude",
      prompt_version: "v1",
      goal: "Add retries",
      device: "laptop",
    },
    {
      id: "d1",
      version: 1,
      status: "superseded",
      created_at: "2026-10-30T10:01:00Z",
      approved_at: null,
      model: "claude",
      prompt_version: "v1",
      goal: "Add retries",
      device: null,
    },
  ],
  links: [{ slug: "pay-faq", title: "Payments FAQ", expires_at: "2026-12-01T00:00:00Z" }],
  capture: null,
};

const full = (id: string, version: number, decisions: string[]) => ({
  id,
  session_id: "s1",
  version,
  status: "approved",
  created_at: "2026-10-30T10:00:00Z",
  approved_at: null,
  content: {
    goal: "Add retries",
    decisions: decisions.map((what, i) => ({ id: i + 1, what, why: "" })),
    outcome: "",
    open_items: [],
    modules: [],
  },
});

describe("Session detail", () => {
  it("shows agent, branches, versions with a comparison and the links using it", async () => {
    stubApi([
      ["/v1/sessions/s1", detail],
      ["/v1/digests/d2", full("d2", 2, ["Use exponential backoff", "Cap at 5 tries"])],
      ["/v1/digests/d1", full("d1", 1, ["Use exponential backoff", "Retry forever"])],
    ]);
    renderAt("/library/sessions/s1");
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("12 events")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.getByText(/Capture details live on the device/)).toBeTruthy();
    expect(await screen.findByText("Cap at 5 tries")).toBeTruthy();
    expect(screen.getByText("Retry forever").closest("li")?.textContent).toContain("Removed:");
    expect(screen.getByText("Cap at 5 tries").closest("li")?.textContent).toContain("Added:");
    const link = screen.getByRole("link", { name: "Payments FAQ" });
    expect(link.getAttribute("href")).toContain("/links?q=pay-faq");
    expect(screen.getByRole("link", { name: "New Ask Link" })).toBeTruthy();
  });

  it("deletes the session after confirming and goes back to the list", async () => {
    const fetch = stubApi([
      ["/v1/sessions/s1", detail],
      ["/v1/digests/", full("d", 1, [])],
      ["DELETE /v1/sessions/s1", { deleted: "s1", digests: 2, tombstone: false, links: [] }],
      ["/v1/projects", { items: [] }],
      ["/v1/sessions", { items: [], total: 0, limit: 50, offset: 0, next_offset: null }],
    ]);
    const { router } = renderAt("/library/sessions/s1");
    await userEvent.click(await screen.findByRole("button", { name: "Delete session" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this session?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete session" }));
    await waitFor(() => expect(sent(fetch, "DELETE", "/v1/sessions/s1")).toHaveLength(1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/library/sessions"));
  });

  it("does not delete when the confirm is cancelled", async () => {
    const fetch = stubApi([
      ["/v1/sessions/s1", detail],
      ["/v1/digests/", full("d", 1, [])],
    ]);
    renderAt("/library/sessions/s1");
    await userEvent.click(await screen.findByRole("button", { name: "Delete session" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getAllByRole("button", { name: "Cancel" })[0] as HTMLElement,
    );
    expect(sent(fetch, "DELETE", "/v1/sessions")).toEqual([]);
  });

  it("withdraws the approved digest", async () => {
    const fetch = stubApi([
      ["/v1/sessions/s1", detail],
      ["/v1/digests/d2/withdraw", () => Response.json({ status: "withdrawn" })],
      ["POST /v1/digests/d2/withdraw", { status: "withdrawn" }],
      ["/v1/digests/", full("d", 1, [])],
    ]);
    renderAt("/library/sessions/s1");
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(sent(fetch, "POST", "/v1/digests/d2/withdraw")).toHaveLength(1));
  });

  it("moves the session to another task of the project in one request", async () => {
    const fetch = stubApi([
      ["/v1/sessions/s1", detail],
      ["/v1/digests/", full("d", 1, [])],
      ["/v1/bundles", { items: bundles }],
      ["POST /v1/bundles/b2/sessions", { id: "b2", remaining: [] }],
    ]);
    renderAt("/library/sessions/s1");
    await userEvent.click(await screen.findByRole("button", { name: "Move to task" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to another task" });
    const select = await within(dialog).findByRole("combobox", { name: "Task" });
    // Only other tasks of the same project are offered.
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Checkout copy"]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(sent(fetch, "POST", "/v1/bundles/b2/sessions")).toEqual([{ session_ids: ["s1"] }]),
    );
    expect(sent(fetch, "POST", "/v1/bundles/merge")).toEqual([]);
    expect(sent(fetch, "POST", "/v1/bundles/b1/split")).toEqual([]);
  });

  it("says when the session is gone", async () => {
    stubApi([]);
    renderAt("/library/sessions/nope");
    expect(await screen.findByText("This session no longer exists")).toBeTruthy();
  });
});

describe("Digests tab", () => {
  it("filters by status", async () => {
    const fetch = stubApi([
      ["/v1/projects", { items: [] }],
      ["/v1/bundles", { items: bundles }],
      [
        "/v1/digests",
        {
          items: [
            {
              id: "d2",
              session_id: "s1",
              version: 2,
              status: "draft",
              created_at: "2026-10-30T11:00:00Z",
              approved_at: null,
              goal: "Add retries",
              decisions: 3,
              agent: "cursor",
              agent_session_id: "x",
              project_id: "p1",
              project: "shop",
              bundle_id: "b1",
              bundle: "Retry payments",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
          next_offset: null,
        },
      ],
    ]);
    renderAt("/library/digests");
    expect(await screen.findByText("Add retries")).toBeTruthy();
    expect(screen.getByText("v2 · 3 decisions")).toBeTruthy();
    expect(within(screen.getByRole("table")).getByText("Draft")).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "superseded");
    await waitFor(() =>
      expect(gets(fetch, "/v1/digests").some((u) => u.includes("status=superseded"))).toBe(true),
    );
  });
});

const hit = (id: string, bundle_id: string, bundle: string, text: string): SearchHit => ({
  id,
  kind: "decision",
  text,
  rationale: null,
  labels: null,
  score: 1,
  digest_id: "d1",
  digest_version: 1,
  session_id: "s1",
  bundle_id,
  bundle,
  project_id: "p1",
  project: "shop",
  ended_at: null,
});

describe("Search", () => {
  it("submits the search box and shows results grouped by task", async () => {
    const fetch = stubApi([
      ["/v1/bundles", { items: bundles }],
      [
        "/v1/search",
        {
          mode: "text",
          items: [
            hit("i1", "b1", "Retry payments", "Use backoff"),
            hit("i2", "b2", "Checkout copy", "Shorter button"),
            hit("i3", "b1", "Retry payments", "Cap retries"),
          ],
        },
      ],
    ]);
    const { router } = renderAt("/library/tasks");
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Search your approved work" }),
      "retry{Enter}",
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/library/search"));
    expect(await screen.findByText("3 results")).toBeTruthy();
    expect(gets(fetch, "/v1/search")[0]).toContain("q=retry");
    const group = screen.getByRole("link", { name: "Retry payments" }).closest("section");
    expect(group?.textContent).toContain("Use backoff");
    expect(group?.textContent).toContain("Cap retries");
    expect(group?.textContent).not.toContain("Shorter button");
    expect(screen.getByText(/text matches only/)).toBeTruthy();
  });

  it("shows the empty result state", async () => {
    stubApi([["/v1/search", { mode: "hybrid", items: [] }]]);
    renderAt("/library/search?q=nothing");
    expect(await screen.findByText("Nothing matches")).toBeTruthy();
  });
});

describe("helpers", () => {
  it("groupByTask keeps the order of each task's best hit", () => {
    const g = groupByTask([
      hit("1", "b2", "B", "x"),
      hit("2", "b1", "A", "y"),
      hit("3", "b2", "B", "z"),
    ]);
    expect(g.map((x) => [x.bundleId, x.hits.map((h) => h.id)])).toEqual([
      ["b2", ["1", "3"]],
      ["b1", ["2"]],
    ]);
  });

  it("diffDigests marks added, removed and unchanged lines", () => {
    const base = { goal: "G", decisions: [], outcome: "", open_items: ["a"], modules: [] };
    const s = diffDigests(base, { ...base, open_items: ["a", "b"] });
    expect(s).toEqual([
      { key: "goal", lines: [{ mark: "same", text: "G" }] },
      {
        key: "open_items",
        lines: [
          { mark: "same", text: "a" },
          { mark: "added", text: "b" },
        ],
      },
    ]);
    expect(hasChanges(s)).toBe(true);
    expect(hasChanges(diffDigests(base, base))).toBe(false);
  });
});
