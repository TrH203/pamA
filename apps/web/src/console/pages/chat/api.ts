// Owner chat API ("ask my agent", spec 008 US4). Shapes follow
// apps/server/src/routes/conversations.ts (/v1/chat*) and review.ts (/v1/projects, /v1/bundles).
import { api } from "../../../lib/api.ts";
import type { Citation, ConversationSummary, Page, SourceRef } from "../conversations/api.ts";
import type { ScopeOption } from "./ScopeCombobox.tsx";

export interface ChatAnswer {
  conversation_id: string;
  ask_id: string;
  status: "answered" | "refused";
  answer?: string;
  reason?: string;
  citations: Citation[];
  confidence: number;
  language: string;
  scope: SourceRef[] | null;
}

export interface CreatedLink {
  slug: string;
  url: string;
  pin?: string;
  suggested_questions: string[];
  sources: SourceRef[];
}

export const chatKeys = {
  list: ["conversations", "chats"] as const,
  scopes: ["chat", "scopes"] as const,
};

export const chatApi = {
  list: () => api<Page<ConversationSummary>>("/v1/chat/conversations?limit=100"),
  send: (question: string, opts: { conversation_id?: string; scope?: SourceRef[] }) =>
    api<ChatAnswer>("/v1/chat", {
      json: {
        question,
        ...(opts.conversation_id ? { conversation_id: opts.conversation_id } : {}),
        ...(!opts.conversation_id && opts.scope?.length ? { scope: opts.scope } : {}),
      },
    }),
  createLink: (id: string) =>
    api<CreatedLink>(`/v1/chat/${encodeURIComponent(id)}/link`, { json: {} }),
};

/** Projects and tasks as scope options (labels come from the caller's locale). */
export async function scopeOptions(groups: {
  projects: string;
  tasks: string;
}): Promise<ScopeOption[]> {
  const [projects, bundles] = await Promise.all([
    api<{ items: { id: string; name: string }[] }>("/v1/projects"),
    api<{ items: { id: string; name: string; project: string }[] }>("/v1/bundles"),
  ]);
  return [
    ...projects.items.map((p) => ({
      ref: { type: "project" as const, id: p.id },
      label: p.name,
      group: groups.projects,
    })),
    ...bundles.items.map((b) => ({
      ref: { type: "bundle" as const, id: b.id },
      label: b.name,
      hint: b.project,
      group: groups.tasks,
    })),
  ];
}
