// Public Ask Link API, mounted at /a/:slug/api (contracts/http-api.md). Every response is labelled
// automated; expired/revoked links return 410 with only the error code; answers never name
// anything outside the link's scope.
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { modelsFor } from "../llm/workspace-models.ts";
import { answerQuestion } from "../pipeline/answer.ts";
import { grantAccess, requireAccess } from "../policy/access.ts";
import { checkAskRate } from "../policy/rate-limit.ts";
import { resolveLink } from "../policy/resolve-link.ts";
import { forwardAsk, recordAsk } from "../services/asks.ts";
import {
  askerIds,
  conversationTurns,
  createConversation,
  priorTurns,
  softDelete,
  visitorConversation,
} from "../services/conversations.ts";
import { body } from "./util.ts";

export const publicRoutes = new Hono<Env>()
  .use("/:slug/*", async (c, next) => {
    // Public requests act in the workspace that owns the link (one server, many workspaces).
    const deps = c.get("deps");
    const [l] = await deps.db.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM ask_links WHERE slug = $1",
      [c.req.param("slug")],
    );
    if (l) {
      c.set("deps", {
        ...deps,
        workspaceId: l.workspace_id,
        models: await modelsFor(deps, l.workspace_id),
      });
    }
    await next();
  })
  .use(async (c, next) => {
    c.header("X-Pama-Automated", "true");
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  })
  .post("/:slug/api/access", async (c) => {
    const link = await resolveLink(c.get("deps").db, c.req.param("slug"));
    const req = await body(
      c,
      z.strictObject({
        pin: z.string().max(16).optional(),
        email: z.string().max(320).optional(),
        otp: z.string().max(12).optional(),
      }),
    );
    await grantAccess(c, link, req);
    return c.body(null, 204);
  })
  .get("/:slug/api/meta", async (c) => {
    const { db } = c.get("deps");
    const link = await resolveLink(db, c.req.param("slug"));
    await requireAccess(c, link);
    const coverage = await db.query<{
      bundle: string;
      project: string;
      sessions: number;
      from: Date;
      to: Date;
    }>(
      `SELECT b.name AS bundle, p.name AS project, count(*)::int AS sessions, min(s.ended_at) AS "from", max(s.ended_at) AS "to"
       FROM sessions s JOIN bundles b ON b.id = s.bundle_id JOIN projects p ON p.id = s.project_id
       WHERE s.id = ANY($1) GROUP BY b.name, p.name ORDER BY max(s.ended_at) DESC`,
      [link.allowedSessionIds],
    );
    const questions = await db.query<{ text: string }>(
      "SELECT text FROM suggested_questions WHERE link_slug = $1 ORDER BY rank",
      [link.slug],
    );
    return c.json({
      owner: link.ownerName,
      title: link.title,
      access_mode: link.accessMode,
      detail: link.detail,
      coverage,
      suggested_questions: questions.map((q) => q.text),
      expires_at: link.expiresAt,
      footer: link.footerEnabled,
    });
  })
  .post("/:slug/api/ask", async (c) => {
    const deps = c.get("deps");
    const link = await resolveLink(deps.db, c.req.param("slug"));
    const visitor = await requireAccess(c, link);
    const { question, conversation_id } = await body(
      c,
      z.strictObject({
        question: z.string().trim().min(1).max(2000),
        conversation_id: z.string().min(1).max(64).optional(),
      }),
    );
    // Without a conversation id (older clients) the question starts a new conversation.
    const conv = conversation_id
      ? await visitorConversation(
          deps.db,
          link.slug,
          await askerIds(deps.db, link.slug, visitor),
          conversation_id,
        )
      : null;
    await checkAskRate(deps.db, link.slug, visitor.id, link.rateLimitPerHour);
    const history = conv ? await priorTurns(deps.db, conv.id) : [];
    const [ws] = await deps.db.query<{ t: number }>(
      "SELECT answer_threshold::float AS t FROM workspaces WHERE id = $1",
      [link.workspaceId],
    );
    const result = await answerQuestion(deps, {
      question,
      scope: {
        workspaceId: link.workspaceId,
        sessionIds: link.allowedSessionIds,
        denyLabels: link.denyLabels,
      },
      detail: link.detail,
      instruction: link.instruction,
      denyTopics: link.denyTopics,
      ownerName: link.ownerName,
      threshold: ws?.t ?? 0.7,
      history,
    });
    // Created only once there is an answer to record, so a failed ask leaves no empty row.
    const conversationId =
      conv?.id ??
      (await createConversation(deps.db, {
        workspaceId: link.workspaceId,
        origin: "link",
        linkSlug: link.slug,
        visitorId: visitor.id,
      }));
    const askId = await recordAsk(deps, {
      origin: "link",
      conversationId,
      linkSlug: link.slug,
      visitorId: visitor.id,
      question,
      result,
    });
    return c.json({
      ask_id: askId,
      conversation_id: conversationId,
      status: result.status,
      ...(result.status === "answered" ? { answer: result.answer } : { reason: result.reason }),
      citations: result.citations.map((x) => ({ item_id: x.item_id, label: x.label })),
      language: result.language,
    });
  })
  .post("/:slug/api/asks/:id/forward", async (c) => {
    const { db } = c.get("deps");
    const link = await resolveLink(db, c.req.param("slug"));
    const visitor = await requireAccess(c, link);
    await forwardAsk(c.get("deps"), link.slug, visitor.id, c.req.param("id"));
    return c.json({ status: "forwarded" }, 202);
  })
  .post("/:slug/api/asks/:id/feedback", async (c) => {
    const { db } = c.get("deps");
    const link = await resolveLink(db, c.req.param("slug"));
    const visitor = await requireAccess(c, link);
    const { useful } = await body(c, z.strictObject({ useful: z.boolean() }));
    const rows = await db.query(
      "UPDATE asks SET useful = $4 WHERE id = $1 AND link_slug = $2 AND visitor_id = $3 RETURNING id",
      [c.req.param("id"), link.slug, visitor.id, useful],
    );
    if (!rows.length) throw new HttpError(404, "not_found", "question not found");
    return c.body(null, 204);
  })
  .get("/:slug/api/asks", async (c) => {
    const { db } = c.get("deps");
    const link = await resolveLink(db, c.req.param("slug"));
    const visitor = await requireAccess(c, link);
    const items = await db.query(
      `SELECT id, conversation_id, question, status, reason, answer, language, owner_reply, owner_replied_at, created_at, useful
       FROM asks a WHERE link_slug = $1 AND visitor_id = $2
         AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = a.conversation_id AND c.deleted_at IS NOT NULL)
       ORDER BY created_at DESC LIMIT 100`,
      [link.slug, visitor.id],
    );
    return c.json({ items });
  })
  // Conversations (spec 008b). "This asker" is the cookie's visitor plus, after email
  // verification, the same verified email on other devices (askerIds).
  .post("/:slug/api/conversations", async (c) => {
    const { db } = c.get("deps");
    const link = await resolveLink(db, c.req.param("slug"));
    const visitor = await requireAccess(c, link);
    // "New chat" reuses this visitor's newest conversation that has no question yet, so repeated
    // clicks (or a script) cannot pile up empty rows; it shares the link's question budget.
    const [empty] = await db.query<{ id: string }>(
      `SELECT c.id FROM conversations c
       WHERE c.link_slug = $1 AND c.visitor_id = $2 AND c.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.conversation_id = c.id)
       ORDER BY c.created_at DESC, c.id DESC LIMIT 1`,
      [link.slug, visitor.id],
    );
    if (empty) {
      await db.query("UPDATE conversations SET last_at = now() WHERE id = $1", [empty.id]);
      return c.json({ id: empty.id, title: "", turns: [] }, 201);
    }
    await checkAskRate(db, link.slug, visitor.id, link.rateLimitPerHour);
    const id = await createConversation(db, {
      workspaceId: link.workspaceId,
      origin: "link",
      linkSlug: link.slug,
      visitorId: visitor.id,
    });
    return c.json({ id, title: "", turns: [] }, 201);
  })
  .get("/:slug/api/conversations", async (c) => {
    const { db } = c.get("deps");
    const link = await resolveLink(db, c.req.param("slug"));
    const visitor = await requireAccess(c, link);
    const items = await db.query(
      `SELECT c.id, c.title, c.created_at, c.last_at,
              (SELECT count(*)::int FROM asks a WHERE a.conversation_id = c.id) AS turns
       FROM conversations c
       WHERE c.link_slug = $1 AND c.visitor_id = ANY($2) AND c.deleted_at IS NULL
       ORDER BY c.last_at DESC LIMIT 100`,
      [link.slug, await askerIds(db, link.slug, visitor)],
    );
    return c.json({ items });
  })
  .get("/:slug/api/conversations/:id", async (c) => {
    const { db } = c.get("deps");
    const link = await resolveLink(db, c.req.param("slug"));
    const visitor = await requireAccess(c, link);
    const conv = await visitorConversation(
      db,
      link.slug,
      await askerIds(db, link.slug, visitor),
      c.req.param("id"),
    );
    // What the asker saw: answers shown, refusal reasons, owner replies. Never the owner's
    // suggested reply, the guard verdict or items outside the link's current scope.
    const allowed = new Set(link.allowedSessionIds);
    const turns = await conversationTurns(db, conv.id);
    const cited = [...new Set(turns.flatMap((t) => t.citations.map((x) => x.item_id)))];
    const labels = cited.length
      ? await db.query<{ id: string; session_id: string; kind: string; bundle: string }>(
          `SELECT i.id, i.session_id, i.kind, b.name AS bundle
           FROM digest_items i JOIN bundles b ON b.id = i.bundle_id
           WHERE i.id = ANY($1) AND i.workspace_id = $2 AND i.active AND NOT (i.labels && $3::text[])`,
          [cited, link.workspaceId, link.denyLabels],
        )
      : [];
    const label = new Map(
      labels
        .filter((l) => allowed.has(l.session_id))
        .map((l) => [l.id, `${l.kind.replace("_", " ")} · ${l.bundle}`]),
    );
    return c.json({
      id: conv.id,
      title: conv.title,
      created_at: conv.created_at,
      last_at: conv.last_at,
      turns: turns.map((t) => ({
        ask_id: t.id,
        question: t.question,
        status: t.status,
        ...(t.status === "answered" ? { answer: t.answer } : { reason: t.reason }),
        citations: t.citations
          .filter((x) => label.has(x.item_id))
          .map((x) => ({ item_id: x.item_id, label: label.get(x.item_id) })),
        language: t.language,
        owner_reply: t.owner_reply,
        owner_replied_at: t.owner_replied_at,
        useful: t.useful,
        created_at: t.created_at,
      })),
    });
  })
  .delete("/:slug/api/conversations/:id", async (c) => {
    const { db } = c.get("deps");
    const link = await resolveLink(db, c.req.param("slug"));
    const visitor = await requireAccess(c, link);
    const conv = await visitorConversation(
      db,
      link.slug,
      await askerIds(db, link.slug, visitor),
      c.req.param("id"),
    );
    await softDelete(db, conv.id);
    return c.body(null, 204);
  });
