// @vitest-environment jsdom
// Desktop popup (spec 008 UI): recent drafts can be reopened, and the scope is picked with a
// searchable combobox that re-drafts with the chosen task.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../lib/providers.tsx";

vi.mock("./ipc.ts", () => ({
  inTauri: () => true,
  onHotkey: () => Promise.resolve(() => undefined),
  ipc: {
    captureSelection: () => Promise.resolve({ text: null, method: "none" }),
    getPermissions: () => Promise.resolve({ accessibility: "granted" }),
    sidecarStatus: () => Promise.resolve({ token: "t" }),
    hidePopup: vi.fn(() => Promise.resolve()),
    pasteDraft: vi.fn(() => Promise.resolve({ ok: true })),
    copyDraft: vi.fn(() => Promise.resolve({ ok: true })),
    openConsole: vi.fn(() => Promise.resolve()),
    openPermissionSettings: vi.fn(() => Promise.resolve()),
  },
}));

const { Popup } = await import("./Popup.tsx");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function stub() {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/v1/draft/recent"))
      return Response.json({
        items: [
          {
            ask_id: "a1",
            conversation_id: "h1",
            question: "Do refunds include shipping?",
            answer: "No, shipping is not refunded.",
            reason: null,
            citations: [{ item_id: "i1", digest_id: "d1", digest_version: 1 }],
            language: "en",
            created_at: "2026-11-01T10:00:00Z",
          },
        ],
      });
    if (url.startsWith("/v1/bundles"))
      return Response.json({
        items: [
          { id: "b1", name: "feat/refunds", project: "shop" },
          { id: "b2", name: "fix/login", project: "auth" },
        ],
      });
    if (url.startsWith("/v1/projects"))
      return Response.json({ items: [{ id: "p1", name: "shop" }] });
    if (url.startsWith("/v1/draft") && init?.method === "POST")
      return Response.json({
        ask_id: "a2",
        status: "answered",
        answer: "Scoped draft.",
        citations: [],
        confidence: 0.9,
        language: "en",
        suggested_scope: [],
      });
    return Response.json({ error: { message: "nope" } }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const renderPopup = () =>
  render(
    <AppProviders>
      <Popup />
    </AppProviders>,
  );

describe("Popup", () => {
  it("lists recent drafts and reopens one", async () => {
    stub();
    renderPopup();
    await userEvent.click(screen.getByRole("button", { name: "Recent drafts" }));
    const item = await screen.findByRole("button", {
      name: "Reopen draft: Do refunds include shipping?",
    });
    await userEvent.click(item);
    expect(await screen.findByText("No, shipping is not refunded.")).toBeTruthy();
    expect((screen.getByLabelText(/Question/) as HTMLTextAreaElement).value).toBe(
      "Do refunds include shipping?",
    );
    expect(screen.getByRole("button", { name: "Paste" }).hasAttribute("disabled")).toBe(false);
  });

  it("picks a scope from the searchable combobox and re-drafts", async () => {
    const fetch = stub();
    renderPopup();
    await userEvent.type(screen.getByLabelText(/Question/), "Why?");
    await userEvent.click(screen.getByRole("button", { name: "Scope" }));
    const combo = await screen.findByRole("combobox", { name: "Scope" });
    await userEvent.click(combo);
    await userEvent.type(combo, "login");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      const posts = fetch.mock.calls.filter(([u, i]) => u === "/v1/draft" && i?.method === "POST");
      expect(JSON.parse(String(posts.at(-1)?.[1]?.body))).toEqual({
        question: "Why?",
        scope_hint: [{ type: "bundle", id: "b2" }],
      });
    });
    expect(await screen.findByText("Scoped draft.")).toBeTruthy();
  });
});
