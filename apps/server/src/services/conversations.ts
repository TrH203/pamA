// Conversations (spec 008b): the thread every ask belongs to. Ask Link visitors chat in
// conversations of origin `link`; the owner's "ask my agent" chat is `owner_chat`; hotkey drafts
// are grouped per UTC day in `hotkey` conversations. Earlier turns are context for the next
// answer (pipeline/answer.ts), never a source of facts or scope.
import { ulid } from "ulid";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/client.ts";
import { HttpError } from "../http.ts";
import { MAX_PRIOR_TURNS, type PriorTurn } from "../pipeline/answer.ts";
import type { SourceRef } from "../policy/resolve-link.ts";

export type ConversationOrigin = "link" | "owner_chat" | "hotkey";

export interface ConversationRow {
  id: string;
  workspace_id: string;
  link_slug: string | null;
  visitor_id: string | null;
  origin: ConversationOrigin;
  title: string;
  scope: SourceRef[] | null;
  status: "open" | "archived";
  created_at: Date;
  last_at: Date;
}

const COLS =
  "id, workspace_id, link_slug, visitor_id, origin, title, scope, status, created_at, last_at";

export const titleFrom = (question: string) => question.replace(/\s+/g, " ").trim().slice(0, 80);

export async function createConversation(
  q: Queryable,
  c: {
    workspaceId: string;
    origin: ConversationOrigin;
    linkSlug?: string;
    visitorId?: string;
    title?: string;
    scope?: SourceRef[] | null;
  },
): Promise<string> {
  const id = ulid();
  await q.query(
    `INSERT INTO conversations (id, workspace_id, link_slug, visitor_id, origin, title, scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      c.workspaceId,
      c.linkSlug ?? null,
      c.visitorId ?? null,
      c.origin,
      (c.title ?? "").slice(0, 200),
      c.scope ? JSON.stringify(c.scope) : null,
    ],
  );
  return id;
}

/** After a new turn: bump `last_at`, reopen, and name an untitled conversation after it. */
export async function touchConversation(q: Queryable, id: string, question: string) {
  await q.query(
    `UPDATE conversations SET last_at = now(), status = 'open',
       title = CASE WHEN title = '' THEN $2 ELSE title END
     WHERE id = $1`,
    [id, titleFrom(question)],
  );
}

/**
 * The visitor ids that count as "this asker" on a link: the cookie's visitor and, once their email
 * is verified, every visitor of the same link verified with the same email (resume on another
 * device after the one-time code).
 *
 * Only an email proven by a one-time code on this link counts: asking for a code for another
 * address clears `verified_at` (grantAccess), and a visitor with a code still pending
 * (`otp_hash` set) is treated as unverified, which also covers rows written before that rule.
 */
export async function askerIds(
  q: Queryable,
  linkSlug: string,
  v: { id: string; email: string | null; verified_at: Date | null; otp_hash?: string | null },
): Promise<string[]> {
  if (!v.email || !v.verified_at || v.otp_hash) return [v.id];
  const rows = await q.query<{ id: string }>(
    `SELECT id FROM visitors
     WHERE link_slug = $1 AND lower(email) = lower($2) AND verified_at IS NOT NULL AND otp_hash IS NULL`,
    [linkSlug, v.email],
  );
  return [...new Set([v.id, ...rows.map((r) => r.id)])];
}

/** A conversation of this asker on this link (404 otherwise, including deleted ones). */
export async function visitorConversation(
  q: Queryable,
  linkSlug: string,
  visitorIds: string[],
  id: string,
): Promise<ConversationRow> {
  const [c] = await q.query<ConversationRow>(
    `SELECT ${COLS} FROM conversations
     WHERE id = $1 AND link_slug = $2 AND visitor_id = ANY($3) AND deleted_at IS NULL`,
    [id, linkSlug, visitorIds],
  );
  if (!c) throw new HttpError(404, "not_found", "conversation not found");
  return c;
}

/** A conversation of the owner's workspace (404 otherwise, including deleted ones). */
export async function ownerConversation(
  deps: Pick<Deps, "db" | "workspaceId">,
  id: string,
  origin?: ConversationOrigin,
): Promise<ConversationRow> {
  const [c] = await deps.db.query<ConversationRow>(
    `SELECT ${COLS} FROM conversations
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND ($3::text IS NULL OR origin = $3)`,
    [id, deps.workspaceId, origin ?? null],
  );
  if (!c) throw new HttpError(404, "not_found", "conversation not found");
  return c;
}

/**
 * The last MAX_PRIOR_TURNS turns of a conversation as the asker saw them: the automated answer
 * when one was shown, the owner's reply when there is one, otherwise no answer. Suggested replies
 * (`draft_answer`) and answers held back by the guard are never included.
 */
export async function priorTurns(q: Queryable, conversationId: string): Promise<PriorTurn[]> {
  const rows = await q.query<{
    question: string;
    status: string;
    answer: string | null;
    owner_reply: string | null;
  }>(
    `SELECT question, status, answer, owner_reply FROM asks
     WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [conversationId, MAX_PRIOR_TURNS],
  );
  return rows.reverse().map((r) => ({
    question: r.question,
    answer:
      r.owner_reply ??
      (r.status === "answered" || r.status === "drafted" ? (r.answer ?? null) : null),
  }));
}

/** Soft delete: hidden at once, purged by the next retention run. */
export async function softDelete(q: Queryable, id: string) {
  await q.query("UPDATE conversations SET deleted_at = now() WHERE id = $1", [id]);
}

export interface ConversationFilter {
  link?: string;
  /** Verified asker email (exact, case-insensitive). */
  asker?: string;
  /** `needs_reply` = has a question forwarded to the owner and not answered yet. */
  status?: "open" | "archived" | "needs_reply";
  origin?: ConversationOrigin;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export async function listConversations(
  deps: Pick<Deps, "db" | "workspaceId">,
  f: ConversationFilter,
) {
  const rows = await deps.db.query<Record<string, unknown>>(
    `SELECT c.id, c.origin, c.link_slug, l.title AS link_title, c.title, c.status, c.created_at, c.last_at,
            CASE WHEN v.verified_at IS NOT NULL THEN v.email END AS asker_email,
            (SELECT count(*)::int FROM asks a WHERE a.conversation_id = c.id) AS turns,
            (SELECT count(*)::int FROM asks a WHERE a.conversation_id = c.id AND a.status = 'forwarded') AS needs_reply
     FROM conversations c
       LEFT JOIN ask_links l ON l.slug = c.link_slug
       LEFT JOIN visitors v ON v.id = c.visitor_id
     WHERE c.workspace_id = $1 AND c.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM asks a WHERE a.conversation_id = c.id)
       AND ($2::text IS NULL OR c.link_slug = $2)
       AND ($3::text IS NULL OR (lower(v.email) = lower($3) AND v.verified_at IS NOT NULL))
       AND ($4::text IS NULL
            OR ($4 = 'needs_reply' AND EXISTS (SELECT 1 FROM asks a WHERE a.conversation_id = c.id AND a.status = 'forwarded'))
            OR c.status = $4)
       AND ($5::text IS NULL OR c.origin = $5)
       AND ($6::timestamptz IS NULL OR c.last_at >= $6)
       AND ($7::timestamptz IS NULL OR c.last_at < $7)
     ORDER BY c.last_at DESC, c.id DESC
     LIMIT $8 OFFSET $9`,
    [
      deps.workspaceId,
      f.link ?? null,
      f.asker ?? null,
      f.status ?? null,
      f.origin ?? null,
      f.from ?? null,
      f.to ?? null,
      f.limit + 1,
      f.offset,
    ],
  );
  const more = rows.length > f.limit;
  return {
    items: rows.slice(0, f.limit),
    next_offset: more ? f.offset + f.limit : null,
  };
}

export interface TurnCitation {
  item_id: string;
  digest_id: string;
  digest_version: number;
  kind?: string;
  text?: string;
}

/** Every turn with its status, answer, citations (resolved to item text) and owner reply. */
export async function conversationTurns(q: Queryable, conversationId: string) {
  const turns = await q.query<{
    id: string;
    question: string;
    language: string | null;
    status: string;
    reason: string | null;
    answer: string | null;
    citations: TurnCitation[];
    confidence: number | null;
    guard: unknown;
    owner_reply: string | null;
    owner_replied_at: Date | null;
    draft_answer: string | null;
    useful: boolean | null;
    created_at: Date;
  }>(
    `SELECT id, question, language, status, reason, answer, citations, confidence, guard, owner_reply,
            owner_replied_at, draft_answer, useful, created_at
     FROM asks WHERE conversation_id = $1 ORDER BY created_at, id`,
    [conversationId],
  );
  const ids = [...new Set(turns.flatMap((t) => t.citations.map((c) => c.item_id)))];
  const items = ids.length
    ? await q.query<{ id: string; kind: string; text: string }>(
        "SELECT id, kind, text FROM digest_items WHERE id = ANY($1)",
        [ids],
      )
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  return turns.map((t) => ({
    ...t,
    citations: t.citations.map((c) => ({
      ...c,
      kind: byId.get(c.item_id)?.kind,
      text: byId.get(c.item_id)?.text,
    })),
  }));
}
