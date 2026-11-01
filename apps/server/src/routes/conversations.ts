// Owner API for conversations (spec 008b): Ask Link conversations with filters (the inbox is
// status=needs_reply), turns with citations, replies, archive/delete and export; the owner's own
// multi-turn chat ("ask my agent") and an Ask Link made from a chat's scope; retention setting.
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { CONVERSATION_ORIGINS } from "../db/schema/conversations.ts";
import { HttpError } from "../http.ts";
import { recordAsk, replyToAsk } from "../services/asks.ts";
import {
  type ConversationFilter,
  conversationTurns,
  createConversation,
  listConversations,
  ownerConversation,
  priorTurns,
  softDelete,
} from "../services/conversations.ts";
import { createLink, LinkInputSchema, SourceRefSchema } from "../services/links.ts";
import { draftForOwner } from "./draft.ts";
import { body } from "./util.ts";

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting with =, +, -, @ or their
 * full-width forms, also after leading spaces, or starting with a tab or line break) gets a leading
 * `'` so it shows as text (OWASP CSV injection). Numbers, booleans and dates are left as they are.
 */
export const csvCell = (v: unknown) => {
  let s =
    v === null || v === undefined
      ? ""
      : typeof v === "string"
        ? v
        : v instanceof Date
          ? v.toISOString()
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
  if (typeof v === "string" && /^(?:[\s\u00a0]*[=+\-@\uff1d\uff0b\uff0d\uff20]|[\t\r\n])/.test(s))
    s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Conversations per export request; past this the response carries `next_offset`. */
export const EXPORT_MAX_CONVERSATIONS = 2000;

const FilterSchema = z.object({
  link: z.string().max(64).optional(),
  asker: z.string().max(320).optional(),
  status: z.enum(["open", "archived", "needs_reply"]).optional(),
  origin: z.enum(CONVERSATION_ORIGINS).optional(),
  from: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  to: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function filter(q: Record<string, string>): ConversationFilter {
  const r = FilterSchema.safeParse(q);
  if (!r.success) throw new HttpError(422, "invalid_request", r.error.message);
  return r.data;
}

const ChatSchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  conversation_id: z.string().min(1).max(64).optional(),
  /** Only when starting a conversation; default: all approved work. */
  scope: z.array(SourceRefSchema).min(1).max(20).optional(),
});

const ChatLinkSchema = LinkInputSchema.omit({ sources: true });

export const conversationRoutes = new Hono<Env>()
  .get("/conversations", async (c) => {
    return c.json(await listConversations(c.get("deps"), filter(c.req.query())));
  })
  // Every turn of the matching conversations, flat, for audit or analysis outside pamA.
  .get("/conversations/export", async (c) => {
    const deps = c.get("deps");
    // `offset` pages through exports larger than EXPORT_MAX_CONVERSATIONS; `next_offset` (JSON
    // field, or the X-Pama-Next-Offset header for CSV) says there is more.
    const f = { ...filter(c.req.query()), limit: EXPORT_MAX_CONVERSATIONS };
    const page = await listConversations(deps, f);
    const convs = page.items as { id: string }[];
    const rows = await deps.db.query<Record<string, unknown>>(
      `SELECT a.conversation_id, c.origin, c.link_slug, c.title AS conversation_title,
              CASE WHEN v.verified_at IS NOT NULL THEN v.email END AS asker_email,
              a.id AS ask_id, a.created_at, a.question, a.language, a.status, a.reason, a.answer,
              a.citations, a.confidence, a.owner_reply, a.owner_replied_at, a.useful
       FROM asks a JOIN conversations c ON c.id = a.conversation_id
         LEFT JOIN visitors v ON v.id = c.visitor_id
       WHERE a.workspace_id = $1 AND a.conversation_id = ANY($2)
       ORDER BY c.last_at DESC, a.conversation_id, a.created_at`,
      [deps.workspaceId, convs.map((x) => x.id)],
    );
    if (c.req.query("format") === "csv") {
      const cols = Object.keys(rows[0] ?? { conversation_id: "" });
      const csv = [
        cols.join(","),
        ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(",")),
      ].join("\n");
      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="pama-conversations.csv"',
        ...(page.next_offset !== null ? { "x-pama-next-offset": String(page.next_offset) } : {}),
      });
    }
    return c.json({ items: rows, next_offset: page.next_offset });
  })
  .get("/conversations/:id", async (c) => {
    const deps = c.get("deps");
    const conv = await ownerConversation(deps, c.req.param("id"));
    const [asker] = conv.visitor_id
      ? await deps.db.query<{ email: string | null }>(
          "SELECT CASE WHEN verified_at IS NOT NULL THEN email END AS email FROM visitors WHERE id = $1",
          [conv.visitor_id],
        )
      : [];
    const [link] = conv.link_slug
      ? await deps.db.query<{ title: string }>("SELECT title FROM ask_links WHERE slug = $1", [
          conv.link_slug,
        ])
      : [];
    return c.json({
      ...conv,
      link_title: link?.title ?? null,
      asker_email: asker?.email ?? null,
      turns: (await conversationTurns(deps.db, conv.id)).map(({ draft_answer, ...t }) => ({
        ...t,
        suggestion: draft_answer,
      })),
    });
  })
  // Reply in the thread: to the given question, or the latest one that is waiting for the owner.
  .post("/conversations/:id/reply", async (c) => {
    const deps = c.get("deps");
    const { text, ask_id } = await body(
      c,
      z.strictObject({ text: z.string().min(1).max(5000), ask_id: z.string().max(64).optional() }),
    );
    const conv = await ownerConversation(deps, c.req.param("id"), "link");
    const [target] = await deps.db.query<{ id: string }>(
      `SELECT id FROM asks WHERE conversation_id = $1 AND ($2::text IS NULL OR id = $2)
         AND status IN ('forwarded', 'refused', 'owner_answered')
       ORDER BY (status = 'forwarded') DESC, created_at DESC LIMIT 1`,
      [conv.id, ask_id ?? null],
    );
    if (!target)
      throw new HttpError(404, "not_found", "no question to reply to in this conversation");
    await replyToAsk(deps, target.id, text);
    return c.json({ ask_id: target.id, status: "owner_answered" });
  })
  .patch("/conversations/:id", async (c) => {
    const deps = c.get("deps");
    const { status, title } = await body(
      c,
      z.strictObject({
        status: z.enum(["open", "archived"]).optional(),
        title: z.string().max(200).optional(),
      }),
    );
    const conv = await ownerConversation(deps, c.req.param("id"));
    await deps.db.query(
      "UPDATE conversations SET status = COALESCE($2, status), title = COALESCE($3, title) WHERE id = $1",
      [conv.id, status ?? null, title ?? null],
    );
    return c.json({ id: conv.id, status: status ?? conv.status, title: title ?? conv.title });
  })
  .delete("/conversations/:id", async (c) => {
    const deps = c.get("deps");
    const conv = await ownerConversation(deps, c.req.param("id"));
    await softDelete(deps.db, conv.id);
    return c.body(null, 204);
  })
  // "Ask my agent": the owner's multi-turn chat over all approved work or a chosen scope, through
  // the same answer pipeline (scope, cite-or-refuse, Layer 3 guard) as Ask Links.
  .post("/chat", async (c) => {
    const deps = c.get("deps");
    const input = await body(c, ChatSchema);
    const conv = input.conversation_id
      ? await ownerConversation(deps, input.conversation_id, "owner_chat")
      : null;
    if (conv && input.scope) {
      throw new HttpError(
        422,
        "invalid_request",
        "scope is fixed when a conversation starts; start a new chat to change it",
      );
    }
    const scope = conv ? conv.scope : (input.scope ?? null);
    const history = conv ? await priorTurns(deps.db, conv.id) : [];
    const result = await draftForOwner(deps, {
      question: input.question,
      scope_hint: scope ?? undefined,
      history,
    });
    const conversationId =
      conv?.id ??
      (await createConversation(deps.db, {
        workspaceId: deps.workspaceId,
        origin: "owner_chat",
        scope,
      }));
    const askId = await recordAsk(deps, {
      origin: "owner_chat",
      conversationId,
      question: input.question,
      result,
    });
    return c.json({
      conversation_id: conversationId,
      ask_id: askId,
      status: result.status,
      ...(result.status === "answered" ? { answer: result.answer } : { reason: result.reason }),
      citations: result.citations.map((x) => ({ item_id: x.item_id, label: x.label })),
      confidence: result.confidence,
      language: result.language,
      scope,
    });
  })
  .get("/chat/conversations", async (c) => {
    const q = filter({ ...c.req.query(), origin: "owner_chat" });
    return c.json(await listConversations(c.get("deps"), q));
  })
  // An Ask Link with the chat's scope: the chosen sources, or (chat over everything) the tasks
  // whose items the chat's answers cited.
  .post("/chat/:id/link", async (c) => {
    const deps = c.get("deps");
    const raw = await c.req.json().catch(() => ({}));
    const settings = ChatLinkSchema.safeParse(raw ?? {});
    if (!settings.success) throw new HttpError(422, "invalid_request", settings.error.message);
    const conv = await ownerConversation(deps, c.req.param("id"), "owner_chat");
    let sources = conv.scope ?? [];
    if (!sources.length) {
      const rows = await deps.db.query<{ bundle_id: string }>(
        `SELECT DISTINCT i.bundle_id FROM asks a
           CROSS JOIN LATERAL jsonb_array_elements(a.citations) AS cit
           JOIN digest_items i ON i.id = cit->>'item_id'
         WHERE a.conversation_id = $1 AND i.workspace_id = $2 AND i.active`,
        [conv.id, deps.workspaceId],
      );
      sources = rows.map((r) => ({ type: "bundle" as const, id: r.bundle_id }));
    }
    if (!sources.length) {
      throw new HttpError(
        422,
        "no_scope",
        "This chat has no scope and no cited answers yet; ask something first or choose a scope.",
      );
    }
    const link = await createLink(deps, {
      ...(raw as Record<string, unknown>),
      sources: sources.slice(0, 50),
    } as Parameters<typeof createLink>[1]);
    return c.json({ ...link, sources }, 201);
  })
  .get("/settings/retention", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const [w] = await db.query<{ ask_retention_days: number }>(
      "SELECT ask_retention_days FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    return c.json({ ask_retention_days: w?.ask_retention_days ?? 180 });
  })
  .put("/settings/retention", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const { ask_retention_days } = await body(
      c,
      z.strictObject({ ask_retention_days: z.int().min(1).max(3650) }),
    );
    await db.query("UPDATE workspaces SET ask_retention_days = $2 WHERE id = $1", [
      workspaceId,
      ask_retention_days,
    ]);
    return c.json({ ask_retention_days });
  });
