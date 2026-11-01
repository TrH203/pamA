// Hotkey drafts (US3, FR-019/029): the owner selected a question somewhere; answer it from their
// approved items (or a scope hint), with the same retrieval, cite-or-refuse and Layer 3 guard as
// Ask Links. The draft is only shown to the owner; pamA never sends it (Constitution III).
import { Hono } from "hono";
import { z } from "zod";
import type { Deps, Env } from "../app.ts";
import { type AnswerResult, answerQuestion, type PriorTurn } from "../pipeline/answer.ts";
import { recordAsk } from "../services/asks.ts";
import { createConversation } from "../services/conversations.ts";
import { SourceRefSchema } from "../services/links.ts";
import { body } from "./util.ts";

const DraftSchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  scope_hint: z.array(SourceRefSchema).max(20).optional(),
  shorter: z.boolean().optional(),
});

/** Answer as the owner would see it: from all of their approved work, or the hinted part of it. */
export async function draftForOwner(
  deps: Pick<Deps, "db" | "models" | "rules" | "workspaceId">,
  input: {
    question: string;
    scope_hint?: z.infer<typeof SourceRefSchema>[];
    shorter?: boolean;
    /** Earlier turns of an owner chat (spec 008b); context only. */
    history?: PriorTurn[];
  },
): Promise<AnswerResult> {
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
  return answerQuestion(deps, {
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
    history: input.history,
  });
}

/** Hotkey drafts are grouped in one conversation per workspace and UTC day (spec 008b). */
async function hotkeyConversation(deps: Pick<Deps, "db" | "workspaceId">): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const [c] = await deps.db.query<{ id: string }>(
    `SELECT id FROM conversations
     WHERE workspace_id = $1 AND origin = 'hotkey' AND deleted_at IS NULL
       AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $2
     ORDER BY created_at LIMIT 1`,
    [deps.workspaceId, day],
  );
  return (
    c?.id ??
    createConversation(deps.db, {
      workspaceId: deps.workspaceId,
      origin: "hotkey",
      title: `Drafts ${day}`,
    })
  );
}

export const draftRoutes = new Hono<Env>()
  // Recent hotkey drafts, newest first, so the desktop popup can show and reopen them.
  .get("/draft/recent", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);
    const items = await db.query(
      `SELECT a.id AS ask_id, a.conversation_id, a.question, a.answer, a.reason, a.citations, a.language, a.created_at
       FROM asks a LEFT JOIN conversations c ON c.id = a.conversation_id
       WHERE a.workspace_id = $1 AND a.origin = 'hotkey' AND c.deleted_at IS NULL
       ORDER BY a.created_at DESC, a.id DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return c.json({ items });
  })
  .post("/draft", async (c) => {
    const deps = c.get("deps");
    const input = await body(c, DraftSchema);
    const result = await draftForOwner(deps, input);
    const askId = await recordAsk(deps, {
      origin: "hotkey",
      conversationId: await hotkeyConversation(deps),
      question: input.question,
      result,
    });

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
