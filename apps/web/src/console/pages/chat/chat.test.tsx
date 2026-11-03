// @vitest-environment jsdom
// Chat page (spec 008 UI, US4): empty state, scoped first question, multi-turn follow-up in the
// same conversation, citations to the Library, "Create Ask Link from this chat", scope combobox.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail, Turn } from "../conversations/api.ts";
import { renderAt, sent, stubApi } from "../conversations/test-utils.tsx";
import { ScopeCombobox, type ScopeRef } from "./ScopeCombobox.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: "a1",
  question: "What did we decide on refunds?",
  language: "en",
  status: "answered",
  reason: null,
  answer: "Shipping is not refunded.",
  citations: [{ item_id: "it1", digest_id: "d1", digest_version: 1, kind: "decision", text: "No" }],
  confidence: 0.9,
  owner_reply: null,
  owner_replied_at: null,
  suggestion: null,
  useful: null,
  created_at: "2026-11-01T10:00:00Z",
  ...over,
});

const chat = (turns: Turn[], scope: ConversationDetail["scope"] = null): ConversationDetail => ({
  id: "k1",
  origin: "owner_chat",
  link_slug: null,
  link_title: null,
  asker_email: null,
  title: "What did we decide on refunds?",
  scope,
  status: "open",
  created_at: "2026-11-01T10:00:00Z",
  last_at: "2026-11-01T10:00:00Z",
  turns,
});

const scopes: [string, unknown][] = [
  ["/v1/projects", { items: [{ id: "p1", name: "shop" }] }],
  ["/v1/bundles", { items: [{ id: "b1", name: "feat/refund-shipping", project: "shop" }] }],
];

describe("Chat", () => {
  it("starts a scoped chat, then follows up in the same conversation", async () => {
    let turns: Turn[] = [];
    const fetch = stubApi([
      ...scopes,
      ["/v1/chat/conversations", { items: [], next_offset: null }],
      [
        "POST /v1/chat",
        (_u: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          turns = [...turns, turn({ id: `a${turns.length + 1}`, question: body.question })];
          return Response.json({
            conversation_id: "k1",
            ask_id: "a1",
            status: "answered",
            answer: "Shipping is not refunded.",
            citations: [{ item_id: "it1", label: "decision · refunds" }],
            confidence: 0.9,
            language: "en",
            scope: body.scope ?? null,
          });
        },
      ],
      ["/v1/conversations/k1", () => Response.json(chat(turns, [{ type: "bundle", id: "b1" }]))],
    ]);
    const { router } = renderAt("/chat");
    expect(await screen.findByText("Ask your agent")).toBeTruthy();
    expect(await screen.findByText("No chats yet")).toBeTruthy();

    const scope = screen.getByRole("combobox", { name: "Scope" });
    await userEvent.click(scope);
    await userEvent.type(scope, "refund");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Remove feat/refund-shipping" })).toBeTruthy();

    const box = screen.getByRole("textbox", { name: "Ask about your work…" });
    await userEvent.type(box, "What did we decide on refunds?{Enter}");
    await waitFor(() => expect(router.state.location.search).toEqual({ c: "k1" }));
    expect(await screen.findByText("Shipping is not refunded.")).toBeTruthy();
    expect(sent(fetch, "POST", "/v1/chat")[0]).toEqual({
      question: "What did we decide on refunds?",
      scope: [{ type: "bundle", id: "b1" }],
    });
    const cite = screen.getByRole("link", { name: /\[1\] decision · No/ });
    expect(cite.getAttribute("href")).toBe("/library/search?q=No");
    // The scope is fixed once the chat has started.
    expect(screen.getByRole("combobox", { name: "Scope" }).hasAttribute("disabled")).toBe(true);

    await userEvent.type(screen.getByRole("textbox", { name: "Ask about your work…" }), "why?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(sent(fetch, "POST", "/v1/chat")[1]).toEqual({
        question: "why?",
        conversation_id: "k1",
      }),
    );
    expect(await screen.findByText("why?")).toBeTruthy();
  });

  it("creates an Ask Link from the chat and shows it", async () => {
    stubApi([
      ...scopes,
      ["/v1/chat/conversations", { items: [], next_offset: null }],
      [
        "POST /v1/chat/k1/link",
        () =>
          Response.json(
            {
              slug: "xyz",
              url: "https://pama.test/a/xyz",
              pin: "123456",
              suggested_questions: [],
              sources: [{ type: "bundle", id: "b1" }],
            },
            { status: 201 },
          ),
      ],
      ["/v1/conversations/k1", chat([turn()])],
    ]);
    renderAt("/chat?c=k1");
    await screen.findByText("Shipping is not refunded.");
    await userEvent.click(screen.getByRole("button", { name: "Create Ask Link from this chat" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask Link created" });
    expect((within(dialog).getByRole("textbox", { name: "Link" }) as HTMLInputElement).value).toBe(
      "https://pama.test/a/xyz",
    );
    expect((within(dialog).getByRole("textbox", { name: "PIN" }) as HTMLInputElement).value).toBe(
      "123456",
    );
  });

  it("shows an error with retry when the chat can't load", async () => {
    let fail = true;
    stubApi([
      ...scopes,
      ["/v1/chat/conversations", { items: [], next_offset: null }],
      [
        "/v1/conversations/k1",
        () =>
          fail
            ? Response.json({ error: { code: "x", message: "boom" } }, { status: 500 })
            : Response.json(chat([turn()])),
      ],
    ]);
    renderAt("/chat?c=k1");
    expect(await screen.findByText("boom")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Shipping is not refunded.")).toBeTruthy();
  });

  it("keeps the question and shows why when sending fails", async () => {
    stubApi([
      ...scopes,
      ["/v1/chat/conversations", { items: [], next_offset: null }],
      [
        "POST /v1/chat",
        () => Response.json({ error: { code: "x", message: "model down" } }, { status: 502 }),
      ],
    ]);
    renderAt("/chat");
    const box = await screen.findByRole("textbox", { name: "Ask about your work…" });
    await userEvent.type(box, "hello{Enter}");
    expect(await screen.findByText(/model down/)).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("hello");
  });
});

function Single({ onChange }: { onChange: (v: ScopeRef[]) => void }) {
  const [v, setV] = useState<ScopeRef[]>([]);
  return (
    <ScopeCombobox
      label="Scope"
      placeholder="Search"
      emptyLabel="No match"
      allLabel="All my approved work"
      options={[
        { ref: { type: "bundle", id: "b1" }, label: "feat/refunds", group: "Tasks" },
        { ref: { type: "bundle", id: "b2" }, label: "fix/login", group: "Tasks" },
      ]}
      value={v}
      onChange={(x) => {
        setV(x);
        onChange(x);
      }}
    />
  );
}

describe("ScopeCombobox (single)", () => {
  it("filters, picks with the keyboard and shows the choice", async () => {
    const onChange = vi.fn();
    render(<Single onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Scope" }) as HTMLInputElement;
    expect(input.value).toBe("All my approved work");
    await userEvent.click(input);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await userEvent.type(input, "login");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([{ type: "bundle", id: "b2" }]);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("fix/login");
    await userEvent.type(input, "zzz");
    expect(screen.getByText("No match")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
