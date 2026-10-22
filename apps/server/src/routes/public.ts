// Public Ask Link API, mounted at /a/:slug/api (contracts/http-api.md). Every response is labelled
// automated; expired/revoked links return 410 with only the error code; answers never name
// anything outside the link's scope.
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { answerQuestion } from "../pipeline/answer.ts";
import { grantAccess, requireAccess } from "../policy/access.ts";
import { checkAskRate } from "../policy/rate-limit.ts";
import { resolveLink } from "../policy/resolve-link.ts";
import { forwardAsk, recordAsk } from "../services/asks.ts";
import { body } from "./util.ts";

export const publicRoutes = new Hono<Env>()
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
    const { question } = await body(
      c,
      z.strictObject({ question: z.string().trim().min(1).max(2000) }),
    );
    await checkAskRate(deps.db, link.slug, visitor.id, link.rateLimitPerHour);
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
    });
    const askId = await recordAsk(deps, {
      origin: "link",
      linkSlug: link.slug,
      visitorId: visitor.id,
      question,
      result,
    });
    return c.json({
      ask_id: askId,
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
      `SELECT id, question, status, reason, answer, language, owner_reply, owner_replied_at, created_at, useful
       FROM asks WHERE link_slug = $1 AND visitor_id = $2 ORDER BY created_at DESC LIMIT 100`,
      [link.slug, visitor.id],
    );
    return c.json({ items });
  });
