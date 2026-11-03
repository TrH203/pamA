// @vitest-environment jsdom
// Conversations page (spec 008 UI): list with filters, empty/error states, the thread with status
// chips and citations, inline reply with "Suggest a reply", archive and delete.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail, ConversationSummary } from "./api.ts";
import { renderAt, sent, stubApi } from "./test-utils.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const summary = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "c1",
  origin: "link",
  link_slug: "abc",
  link_title: "Refund policy",
  title: "Do refunds include shipping?",
  status: "open",
  created_at: "2026-11-01T10:00:00Z",
  last_at: "2026-11-01T10:05:00Z",
  asker_email: "ana@example.com",
  turns: 2,
  needs_reply: 1,
  ...over,
});

const detail = (over: Partial<ConversationDetail> = {}): ConversationDetail => ({
  id: "c1",
  origin: "link",
  link_slug: "abc",
  link_title: "Refund policy",
  asker_email: "ana@example.com",
  title: "Do refunds include shipping?",
  scope: null,
  status: "open",
  created_at: "2026-11-01T10:00:00Z",
  last_at: "2026-11-01T10:05:00Z",
  turns: [
    {
      id: "a1",
      question: "Do refunds include shipping?",
      language: "en",
      status: "answered",
      reason: null,
      answer: "Refunds do not include the shipping fee.",
      citations: [
        { item_id: "it1", digest_id: "d1", digest_version: 1, kind: "decision", text: "No fee" },
      ],
      confidence: 0.9,
      owner_reply: null,
      owner_replied_at: null,
      suggestion: null,
      useful: true,
      created_at: "2026-11-01T10:00:00Z",
    },
    {
      id: "a2",
      question: "Which merchant account?",
      language: "en",
      status: "forwarded",
      reason: "out_of_scope",
      answer: null,
      citations: [],
      confidence: null,
      owner_reply: null,
      owner_replied_at: null,
      suggestion: null,
      useful: null,
      created_at: "2026-11-01T10:05:00Z",
    },
  ],
  ...over,
});

describe("Conversations list", () => {
  it("lists conversations and filters by Needs reply through the URL", async () => {
    const fetch = stubApi([
      ["/v1/links", { items: [{ slug: "abc", title: "Refund policy" }] }],
      ["/v1/conversations", { items: [summary()], next_offset: null }],
    ]);
    const { router } = renderAt("/conversations");
    const link = await screen.findByRole("link", { name: "Do refunds include shipping?" });
    expect(link.getAttribute("href")).toBe("/conversations/c1");
    expect(screen.getByText("1 waiting")).toBeTruthy();
    expect(screen.getByText("ana@example.com")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Needs reply" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ status: "needs_reply" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([u]) => String(u).includes("/v1/conversations?status=needs_reply")),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Needs reply" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("shows the needs-reply empty state", async () => {
    stubApi([
      ["/v1/links", { items: [] }],
      ["/v1/conversations", { items: [], next_offset: null }],
    ]);
    renderAt("/conversations?status=needs_reply");
    expect(await screen.findByText("Nothing waiting for you")).toBeTruthy();
  });

  it("shows an error with retry", async () => {
    let fail = true;
    stubApi([
      ["/v1/links", { items: [] }],
      [
        "/v1/conversations",
        () =>
          fail
            ? Response.json({ error: { code: "x", message: "boom" } }, { status: 500 })
            : Response.json({ items: [summary()], next_offset: null }),
      ],
    ]);
    renderAt("/conversations");
    expect(await screen.findByText("boom")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Do refunds include shipping?" })).toBeTruthy();
  });

  it("exports CSV with the current filters", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return "blob:x";
    });
    URL.revokeObjectURL = vi.fn();
    const fetch = stubApi([
      ["/v1/links", { items: [] }],
      ["/v1/conversations/export", () => new Response("conversation_id,question\nc1,hi\n")],
      ["/v1/conversations", { items: [summary()], next_offset: null }],
    ]);
    renderAt("/conversations?status=archived");
    await screen.findByRole("link", { name: "Do refunds include shipping?" });
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(
      fetch.mock.calls.some(([u]) =>
        String(u).startsWith("/v1/conversations/export?status=archived&format=csv"),
      ),
    ).toBe(true);
    expect(await created[0]?.text()).toContain("c1,hi");
  });
});

describe("Conversation detail", () => {
  it("shows the thread with statuses and citations linking to the Library", async () => {
    stubApi([["/v1/conversations/c1", detail()]]);
    renderAt("/conversations/c1");
    expect(await screen.findByText("Refunds do not include the shipping fee.")).toBeTruthy();
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.getAllByText("Needs reply").length).toBeGreaterThan(0);
    const cite = screen.getByRole("link", { name: /\[1\] decision · No fee/ });
    expect(cite.getAttribute("href")).toBe("/library/search?q=No+fee");
    expect(screen.getByText("Marked useful")).toBeTruthy();
  });

  it("replies to the forwarded question using a suggested reply", async () => {
    const fetch = stubApi([
      ["POST /v1/asks/a2/suggest", { suggestion: "Not in this project." }],
      ["POST /v1/conversations/c1/reply", { ask_id: "a2", status: "owner_answered" }],
      ["/v1/conversations/c1", detail()],
    ]);
    renderAt("/conversations/c1");
    const form = await screen.findByRole("form", { name: "Reply to this question" });
    await userEvent.click(within(form).getByRole("button", { name: "Suggest a reply" }));
    await userEvent.click(await within(form).findByRole("button", { name: "Use this reply" }));
    await userEvent.click(within(form).getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(sent(fetch, "POST", "/v1/conversations/c1/reply")).toEqual([
        { text: "Not in this project.", ask_id: "a2" },
      ]),
    );
    expect(await screen.findByText("Reply sent")).toBeTruthy();
  });

  it("archives, and deletes after confirmation", async () => {
    const fetch = stubApi([
      ["PATCH /v1/conversations/c1", { id: "c1", status: "archived" }],
      ["DELETE /v1/conversations/c1", () => new Response(null, { status: 204 })],
      ["/v1/conversations/c1", detail()],
      ["/v1/links", { items: [] }],
      ["/v1/conversations", { items: [], next_offset: null }],
    ]);
    const { router } = renderAt("/conversations/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(sent(fetch, "PATCH", "/v1/conversations/c1")).toEqual([{ status: "archived" }]),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/conversations"));
    expect(sent(fetch, "DELETE", "/v1/conversations/c1")).toHaveLength(1);
  });

  it("says when the conversation no longer exists", async () => {
    stubApi([]);
    renderAt("/conversations/gone");
    expect(await screen.findByText("This conversation was deleted or doesn't exist.")).toBeTruthy();
  });
});
