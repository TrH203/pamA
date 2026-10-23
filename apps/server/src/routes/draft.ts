// Hotkey drafts (US3, FR-019/029): the owner selected a question somewhere; answer it from their
// approved items (or a scope hint), with the same retrieval, cite-or-refuse and Layer 3 guard as
// Ask Links. The draft is only shown to the owner; pamA never sends it (Constitution III).
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { answerQuestion } from "../pipeline/answer.ts";
import { recordAsk } from "../services/asks.ts";
import { SourceRefSchema } from "../services/links.ts";
import { body } from "./util.ts";

const DraftSchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  scope_hint: z.array(SourceRefSchema).max(20).optional(),
  shorter: z.boolean().optional(),
});

export const draftRoutes = new Hono<Env>().post("/draft", async (c) => {
  const deps = c.get("deps");
  const input = await body(c, DraftSchema);
  const hint = input.scope_hint ?? [];
  const ids = (t: string) => hint.filter((r) => r.type === t).map((r) => r.id);
  const sessions = await deps.db.query<{ id: string }>(
    `SELECT id FROM sessions WHERE workspace_id = $1
       AND ($2::boolean OR project_id = ANY($3) OR bundle_id = ANY($4) OR id = ANY($5))`,
    [deps.workspaceId, hint.length === 0, ids("project"), ids("bundle"), ids("session")],
  );
  const [ws] = await deps.db.query<{ deny: string[]; t: number; name: string }>(
    "SELECT default_deny_labels AS deny, answer_threshold::float AS t, display_name AS name FROM workspaces WHERE id = $1",
    [deps.workspaceId],
  );
  const result = await answerQuestion(deps, {
    question: input.question,
    scope: {
      workspaceId: deps.workspaceId,
      sessionIds: sessions.map((s) => s.id),
      denyLabels: ws?.deny ?? [],
    },
    detail: "summary",
    instruction: null,
    denyTopics: [],
    ownerName: ws?.name ?? "the owner",
    threshold: ws?.t ?? 0.7,
    shorter: input.shorter,
  });
  const askId = await recordAsk(deps, { origin: "hotkey", question: input.question, result });

  // Suggested scope for "Create Ask Link": bundles of the retrieved items, best first.
  const seen = new Map<string, string>();
  for (const i of result.retrieved) if (!seen.has(i.bundle_id)) seen.set(i.bundle_id, i.bundle);
  return c.json({
    ask_id: askId,
    status: result.status,
    ...(result.status === "answered" ? { answer: result.answer } : { reason: result.reason }),
    citations: result.citations.map((x) => ({ item_id: x.item_id, label: x.label })),
    confidence: result.confidence,
    language: result.language,
    suggested_scope: [...seen].slice(0, 5).map(([id, title]) => ({ type: "bundle", id, title })),
  });
});
