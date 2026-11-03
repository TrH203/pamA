// @vitest-environment jsdom
// Ask page conversations (spec 008 UI, US2): resume the latest conversation, follow-ups carry its
// id, "New conversation", switch and delete from the list, and older servers without
// conversations keep working through /asks.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../lib/providers.tsx";
import { AskPage } from "./AskPage.tsx";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const meta = {
  owner: "Hien",
  title: "Refund policy",
  access_mode: "open",
  detail: "summary",
  coverage: [],
  suggested_questions: ["Why was it decided?"],
  expires_at: "2026-12-01T00:00:00Z",
  footer: false,
};

const turn = (id: string, question: string, answer: string) => ({
  ask_id: id,
  question,
  status: "answered",
  answer,
  citations: [{ item_id: `i-${id}`, label: "decision · refunds" }],
  owner_reply: null,
  useful: null,
  created_at: "2026-11-01T10:00:00Z",
});

const convs = {
  c1: { id: "c1", title: "Shipping", turns: [turn("a1", "Do refunds include shipping?", "No.")] },
  c2: { id: "c2", title: "Taxes", turns: [turn("a2", "And taxes?", "Taxes are refunded.")] },
};

type Handler = (url: string, init?: RequestInit) => Response;

function stub(over: [string, Handler][] = []) {
  const list = [
    { id: "c1", title: "Shipping", created_at: "2026-11-01", last_at: "2026-11-02", turns: 1 },
    { id: "c2", title: "Taxes", created_at: "2026-10-30", last_at: "2026-10-31", turns: 1 },
  ];
  const routes: [string, Handler][] = [
    ...over,
    ["GET /api/meta", () => Response.json(meta)],
    ["GET /api/conversations/c1", () => Response.json(convs.c1)],
    ["GET /api/conversations/c2", () => Response.json(convs.c2)],
    ["GET /api/conversations", () => Response.json({ items: list })],
    [
      "DELETE /api/conversations/",
      (u) => {
        const id = u.split("/").pop();
        list.splice(
          list.findIndex((c) => c.id === id),
          1,
        );
        return new Response(null, { status: 204 });
      },
    ],
    [
      "POST /api/ask",
      (_u, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          ask_id: "new",
          conversation_id: body.conversation_id ?? "c9",
          status: "answered",
          answer: `Answer to ${body.question}`,
          citations: [],
          language: "en",
        });
      },
    ],
  ];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    for (const [key, h] of routes) {
      const [m, p] = key.split(" ");
      if (m === method && url.includes(p as string)) return h(url, init);
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const asked = (fetch: ReturnType<typeof stub>) =>
  fetch.mock.calls
    .filter(([u, i]) => i?.method === "POST" && String(u).includes("/api/ask"))
    .map(([, i]) => JSON.parse(String(i?.body)));

const renderPage = () =>
  render(
    <AppProviders>
      <AskPage />
    </AppProviders>,
  );

describe("Ask page conversations", () => {
  it("resumes the latest conversation and sends follow-ups in it", async () => {
    const fetch = stub();
    renderPage();
    expect(await screen.findByText("No.")).toBeTruthy();
    const box = screen.getByLabelText("Ask a question in any language…");
    await userEvent.type(box, "why?{Enter}");
    expect(await screen.findByText("Answer to why?")).toBeTruthy();
    expect(asked(fetch)).toEqual([{ question: "why?", conversation_id: "c1" }]);
  });

  it("starts a new conversation without an id", async () => {
    const fetch = stub();
    renderPage();
    await screen.findByText("No.");
    await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.queryByText("No.")).toBeNull();
    expect(screen.getByText("Try asking")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Ask a question in any language…"), "hello{Enter}");
    await screen.findByText("Answer to hello");
    expect(asked(fetch)).toEqual([{ question: "hello" }]);
    // The next question continues the conversation the server created.
    await userEvent.type(screen.getByLabelText("Ask a question in any language…"), "more{Enter}");
    await waitFor(() =>
      expect(asked(fetch)[1]).toEqual({ question: "more", conversation_id: "c9" }),
    );
  });

  it("switches to and deletes a conversation from the list", async () => {
    const fetch = stub();
    renderPage();
    await screen.findByText("No.");
    await userEvent.click(screen.getByRole("button", { name: /Your conversations/ }));
    let dialog = await screen.findByRole("dialog", { name: "Your conversations" });
    await userEvent.click(within(dialog).getByRole("button", { name: 'Open "Taxes"' }));
    expect(await screen.findByText("Taxes are refunded.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Your conversations/ }));
    dialog = await screen.findByRole("dialog", { name: "Your conversations" });
    await userEvent.click(within(dialog).getByRole("button", { name: 'Delete "Taxes"' }));
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([u, i]) => i?.method === "DELETE" && String(u).endsWith("/api/conversations/c2"),
        ),
      ).toBe(true),
    );
    // The deleted one was open: the page falls back to the remaining conversation.
    expect(await screen.findByText("No.")).toBeTruthy();
  });

  it("keeps working with a server that has no conversations", async () => {
    const fetch = stub([
      ["GET /api/conversations", () => Response.json({ error: { code: "x" } }, { status: 404 })],
      [
        "GET /api/asks",
        () =>
          Response.json({
            items: [{ id: "o1", question: "Old question", status: "answered", answer: "Old." }],
          }),
      ],
    ]);
    renderPage();
    expect(await screen.findByText("Old.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
    await userEvent.type(screen.getByLabelText("Ask a question in any language…"), "hi{Enter}");
    await screen.findByText("Answer to hi");
    expect(asked(fetch)).toEqual([{ question: "hi" }]);
  });
});
