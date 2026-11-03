// @vitest-environment jsdom
// Review (spec 008a): structured digest editor, schema validation and keyboard shortcuts.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAt, sent, stubApi } from "../library/test-utils.tsx";
import type { Draft } from "./types.ts";
import { fromModel, LIMITS, toModel, validate } from "./validate.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const content = (goal: string): Draft["content"] => ({
  schema_version: 1,
  source: {
    agent: "claude_code" as Draft["content"]["source"]["agent"],
    agent_session_id: "abc",
    project_key: "github.com/acme/shop",
    ended_at: "2026-10-30T10:00:00Z",
  },
  goal,
  decisions: [
    { id: 1, what: "Use exponential backoff", why: "Avoid thundering herd" },
    { id: 2, what: "Cap at 5 tries", why: "", alternatives: ["Retry forever"] },
  ],
  outcome: "Retries ship behind a flag",
  open_items: ["Load test"],
  modules: ["payments/client"],
  redactions: { secret: 1, pii: 0 },
});

const draft = (id: string, goal: string): Draft => ({
  id,
  version: 1,
  status: "draft",
  created_at: "2026-10-30T10:00:00Z",
  project: "shop",
  project_id: "p1",
  bundle: "Retry payments",
  bundle_id: "b1",
  device: "laptop",
  branches: ["feat/retry"],
  content: content(goal),
});

function api(drafts: Draft[]) {
  return stubApi([
    ["/v1/review", { items: drafts }],
    ["/v1/projects", { items: [{ id: "p1", name: "shop", repo_key: "x", auto_approve: false }] }],
    ["POST /v1/digests/", { status: "ok" }],
    ["/v1/activity", { counts: { running: 0, failed: 0 } }],
  ]);
}

describe("structured editor", () => {
  it("edits fields, reorders and adds decisions, then approves the edited digest", async () => {
    const fetch = api([draft("d1", "Add retries")]);
    renderAt("/review");
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("textbox", { name: "Digest JSON" })).toBeNull();
    const goal = screen.getByRole("textbox", { name: "Goal" });
    expect((goal as HTMLTextAreaElement).value).toBe("Add retries");
    await userEvent.clear(goal);
    await userEvent.type(goal, "Add retries to payments");
    await userEvent.click(screen.getByRole("button", { name: "Move decision 1 down" }));
    await userEvent.click(screen.getByRole("button", { name: "Add decision" }));
    const whats = screen.getAllByRole("textbox", { name: "What was decided" });
    await userEvent.type(whats[2] as HTMLElement, "Log every retry");
    await userEvent.click(
      screen.getAllByRole("checkbox", { name: "Infrastructure" })[2] as HTMLElement,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Open items: Item 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save and approve" }));
    await waitFor(() => expect(sent(fetch, "POST", "/v1/digests/d1/approve")).toHaveLength(1));
    const body = sent(fetch, "POST", "/v1/digests/d1/approve")[0] as {
      content: Draft["content"];
    };
    expect(body.content.goal).toBe("Add retries to payments");
    expect(body.content.decisions.map((d) => [d.id, d.what])).toEqual([
      [1, "Cap at 5 tries"],
      [2, "Use exponential backoff"],
      [3, "Log every retry"],
    ]);
    expect(body.content.decisions[0]?.alternatives).toEqual(["Retry forever"]);
    expect(body.content.decisions[2]?.labels).toEqual(["infra"]);
    expect(body.content.open_items).toEqual([]);
    // Untouched fields the server needs are kept.
    expect(body.content.schema_version).toBe(1);
    expect(body.content.redactions).toEqual({ secret: 1, pii: 0 });
  });

  it("blocks saving when the digest breaks the schema", async () => {
    const fetch = api([draft("d1", "Add retries")]);
    renderAt("/review");
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Goal" }));
    await userEvent.click(screen.getByRole("button", { name: "Add decision" }));
    await userEvent.click(screen.getByRole("button", { name: "Save and approve" }));
    expect(await screen.findByText("Fix the highlighted fields before saving.")).toBeTruthy();
    expect(screen.getAllByText("Required.").length).toBe(2);
    expect(screen.getByRole("textbox", { name: "Goal" }).getAttribute("aria-invalid")).toBe("true");
    expect(sent(fetch, "POST", "/v1/digests/d1/approve")).toEqual([]);
  });

  it("cancel returns to the read view", async () => {
    api([draft("d1", "Add retries")]);
    renderAt("/review");
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Goal" })).toBeNull();
    expect(screen.getByText("Use exponential backoff")).toBeTruthy();
  });
});

describe("review queue", () => {
  it("approves without edits and offers the auto-approve toggle", async () => {
    const fetch = api([draft("d1", "Add retries")]);
    renderAt("/review");
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent(fetch, "POST", "/v1/digests/d1/approve")).toEqual([{}]));
    expect(screen.getByRole("switch", { name: /shop/ })).toBeTruthy();
  });

  it("shows a visible shortcut hint and drives the queue from the keyboard", async () => {
    const fetch = api([draft("d1", "First goal"), draft("d2", "Second goal")]);
    renderAt("/review");
    const first = await screen.findByRole("article", { name: "Draft 1 of 2" });
    const hint = screen.getByRole("note", { name: "Keyboard shortcuts" });
    expect(hint.textContent).toContain("approve");
    expect(first.getAttribute("aria-current")).toBe("true");

    fireEvent.keyDown(document.body, { key: "j" });
    const second = screen.getByRole("article", { name: "Draft 2 of 2" });
    expect(second.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(document.body, { key: "a" });
    await waitFor(() => expect(sent(fetch, "POST", "/v1/digests/d2/approve")).toEqual([{}]));

    fireEvent.keyDown(document.body, { key: "k" });
    expect(first.getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(document.body, { key: "d" });
    const dialog = await screen.findByRole("alertdialog", { name: "Discard this digest?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(sent(fetch, "POST", "/v1/digests/d1/discard")).toHaveLength(1));

    fireEvent.keyDown(document.body, { key: "e" });
    expect(await within(first).findByRole("textbox", { name: "Goal" })).toBeTruthy();
    // Typing in the editor does not trigger shortcuts.
    await userEvent.type(within(first).getByRole("textbox", { name: "Goal" }), "a");
    expect(sent(fetch, "POST", "/v1/digests/d1/approve")).toEqual([]);
  });

  it("shows the loading error with a retry", async () => {
    stubApi([
      [
        "/v1/review",
        () => Response.json({ error: { code: "x", message: "down" } }, { status: 500 }),
      ],
      ["/v1/projects", { items: [] }],
    ]);
    renderAt("/review");
    expect(await screen.findByText("down")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("validate", () => {
  it("reads limits from the digest schema", () => {
    expect(LIMITS.goal.maxLength).toBe(1000);
    expect(LIMITS.decisions.maxItems).toBe(30);
    expect(LIMITS.open_items.maxItems).toBe(20);
    expect(LIMITS.modules.items.maxLength).toBe(100);
  });

  it("flags too long and too many entries, and ignores blank list lines", () => {
    const m = toModel(content("ok"));
    expect(validate(m)).toEqual({});
    m.modules = ["x".repeat(101), ""];
    m.open_items = Array.from({ length: 21 }, (_, i) => `item ${i}`);
    m.decisions[0] = { ...(m.decisions[0] as (typeof m.decisions)[number]), why: "y".repeat(1001) };
    expect(validate(m)).toEqual({
      "modules.0": { code: "tooLong", max: 100 },
      open_items: { code: "tooMany", max: 20 },
      "decisions.0.why": { code: "tooLong", max: 1000 },
    });
    const out = fromModel({ ...toModel(content("g")), modules: ["  a ", " "] }, content("g"));
    expect(out.modules).toEqual(["a"]);
  });
});
