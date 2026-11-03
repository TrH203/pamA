// Owner conversation API (spec 008): types, query keys and fetchers shared by the Conversations
// and Chat pages. Shapes follow apps/server/src/routes/conversations.ts.
import type { Tone } from "@pama/ui";
import { ApiError, api, token } from "../../../lib/api.ts";

export type Origin = "link" | "owner_chat" | "hotkey";
export type StatusFilter = "open" | "archived" | "needs_reply";

export interface SourceRef {
  type: "project" | "bundle" | "session";
  id: string;
}

export interface ConversationSummary {
  id: string;
  origin: Origin;
  link_slug: string | null;
  link_title: string | null;
  title: string;
  status: "open" | "archived";
  created_at: string;
  last_at: string;
  asker_email: string | null;
  turns: number;
  needs_reply: number;
}

export interface Page<T> {
  items: T[];
  next_offset: number | null;
}

export interface Citation {
  item_id: string;
  label?: string;
  digest_id?: string;
  digest_version?: number;
  kind?: string;
  text?: string;
}

export interface Turn {
  id: string;
  question: string;
  language: string | null;
  status: string;
  reason: string | null;
  answer: string | null;
  citations: Citation[];
  confidence: number | null;
  owner_reply: string | null;
  owner_replied_at: string | null;
  suggestion: string | null;
  useful: boolean | null;
  created_at: string;
}

export interface ConversationDetail {
  id: string;
  origin: Origin;
  link_slug: string | null;
  link_title: string | null;
  asker_email: string | null;
  title: string;
  scope: SourceRef[] | null;
  status: "open" | "archived";
  created_at: string;
  last_at: string;
  turns: Turn[];
}

export interface Filters {
  status?: StatusFilter;
  link?: string;
  origin?: Origin;
  from?: string;
  to?: string;
}

export function filterQuery(f: Filters & { limit?: number; offset?: number; format?: string }) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const convKeys = {
  all: ["conversations"] as const,
  list: (f: Filters) => ["conversations", "list", f] as const,
  detail: (id: string) => ["conversations", "detail", id] as const,
  chats: ["conversations", "chats"] as const,
};

export const PAGE_SIZE = 50;

export const conversationApi = {
  list: (f: Filters, offset = 0) =>
    api<Page<ConversationSummary>>(
      `/v1/conversations${filterQuery({ ...f, limit: PAGE_SIZE, offset })}`,
    ),
  get: (id: string) => api<ConversationDetail>(`/v1/conversations/${encodeURIComponent(id)}`),
  reply: (id: string, text: string, ask_id?: string) =>
    api<{ ask_id: string; status: string }>(`/v1/conversations/${encodeURIComponent(id)}/reply`, {
      json: ask_id ? { text, ask_id } : { text },
    }),
  patch: (id: string, patch: { status?: "open" | "archived"; title?: string }) =>
    api(`/v1/conversations/${encodeURIComponent(id)}`, { method: "PATCH", json: patch }),
  remove: (id: string) => api(`/v1/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  suggest: (askId: string) =>
    api<{ suggestion: string | null }>(`/v1/asks/${encodeURIComponent(askId)}/suggest`, {
      json: {},
    }),
  dismiss: (askId: string) => api(`/v1/asks/${encodeURIComponent(askId)}/dismiss`, { json: {} }),
  links: () => api<{ items: { slug: string; title: string }[] }>("/v1/links"),
};

/** Tone and label key of a turn's status, so the chip never relies on colour alone. */
export function turnTone(status: string, replied: boolean): Tone {
  if (replied) return "success";
  if (status === "answered" || status === "drafted") return "success";
  if (status === "forwarded") return "accent";
  if (status === "refused") return "warning";
  return "neutral";
}

/** Where a citation opens: the Library search for the cited item's text. */
export const LIBRARY_SEARCH = "/library/search";

/** The search text that finds a cited item in the Library. */
export function librarySearchFor(c: { item_id: string; label?: string; text?: string }): string {
  const text = c.text ?? c.label?.replace(/^[^·]*·\s*/, "") ?? c.item_id;
  return text.slice(0, 120);
}

/** Fetch every export page (the server caps one response at 2000 conversations). */
export async function exportConversations(f: Filters, format: "json" | "csv"): Promise<Blob> {
  const MAX_PAGES = 50;
  if (format === "json") {
    const items: unknown[] = [];
    let offset: number | null = 0;
    for (let i = 0; offset !== null && i < MAX_PAGES; i++) {
      const page: { items: unknown[]; next_offset: number | null } = await api(
        `/v1/conversations/export${filterQuery({ ...f, format: "json", offset })}`,
      );
      items.push(...page.items);
      offset = page.next_offset;
    }
    return new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
  }
  const parts: string[] = [];
  let offset: number | null = 0;
  for (let i = 0; offset !== null && i < MAX_PAGES; i++) {
    const t = token();
    const res: Response = await fetch(
      `/v1/conversations/export${filterQuery({ ...f, format: "csv", offset })}`,
      {
        credentials: "same-origin",
        headers: t ? { authorization: `Bearer ${t}` } : {},
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code: string; message: string };
      };
      throw new ApiError(res.status, body.error?.code ?? "error", body.error?.message ?? "export");
    }
    const text = await res.text();
    // Keep the header row of the first page only.
    parts.push(parts.length ? text.slice(text.indexOf("\n") + 1) : text);
    const next: string | null = res.headers.get("x-pama-next-offset");
    offset = next ? Number(next) : null;
  }
  return new Blob([parts.filter(Boolean).join("\n")], { type: "text/csv;charset=utf-8" });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
