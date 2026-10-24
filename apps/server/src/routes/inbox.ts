// Owner inbox (forwarded questions), replies, and the audit log (FR-015, FR-017).
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { replyToAsk } from "../services/asks.ts";
import { draftForOwner } from "./draft.ts";
import { body } from "./util.ts";

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export const inboxRoutes = new Hono<Env>()
  .get("/inbox", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const items = await db.query(
      `SELECT a.id, a.question, a.language, a.status, a.reason, a.created_at, a.link_slug, l.title AS link_title,
              a.draft_answer AS suggestion,
              v.email AS asker_email, v.verified_at IS NOT NULL AS asker_verified
       FROM asks a LEFT JOIN ask_links l ON l.slug = a.link_slug LEFT JOIN visitors v ON v.id = a.visitor_id
       WHERE a.workspace_id = $1 AND a.status = 'forwarded' ORDER BY a.created_at DESC`,
      [workspaceId],
    );
    return c.json({ items });
  })
  // Suggested reply for a forwarded question: what the link's agent wrote before holding it back,
  // or, when it had nothing, a draft from all of the owner's notes. Only the owner sees it; they
  // edit it and send it with /reply.
  .post("/asks/:id/suggest", async (c) => {
    const deps = c.get("deps");
    const [a] = await deps.db.query<{ question: string; draft_answer: string | null }>(
      "SELECT question, draft_answer FROM asks WHERE id = $1 AND workspace_id = $2 AND status = 'forwarded'",
      [c.req.param("id"), deps.workspaceId],
    );
    if (!a) throw new HttpError(404, "not_found", "no forwarded question with this id");
    if (a.draft_answer) return c.json({ suggestion: a.draft_answer });
    const r = await draftForOwner(deps, { question: a.question });
    const suggestion = r.answer ?? r.draft ?? null;
    if (suggestion) {
      await deps.db.query("UPDATE asks SET draft_answer = $2 WHERE id = $1", [
        c.req.param("id"),
        suggestion,
      ]);
    }
    return c.json({ suggestion });
  })
  .post("/asks/:id/reply", async (c) => {
    const { text } = await body(c, z.strictObject({ text: z.string().min(1).max(5000) }));
    await replyToAsk(c.get("deps"), c.req.param("id"), text);
    return c.json({ status: "owner_answered" });
  })
  .post("/asks/:id/dismiss", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const rows = await db.query(
      "UPDATE asks SET status = 'dismissed' WHERE id = $1 AND workspace_id = $2 AND status = 'forwarded' RETURNING id",
      [c.req.param("id"), workspaceId],
    );
    if (!rows.length) throw new HttpError(404, "not_found", "no forwarded question with this id");
    return c.json({ status: "dismissed" });
  })
  .get("/audit", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const q = c.req.query();
    const rows = await db.query<Record<string, unknown>>(
      `SELECT a.id, a.created_at, a.origin, a.link_slug, a.question, a.language, a.status, a.reason, a.answer,
              a.citations, a.confidence, a.guard, a.owner_reply, a.useful,
              CASE WHEN v.verified_at IS NOT NULL THEN v.email END AS asker_email
       FROM asks a LEFT JOIN visitors v ON v.id = a.visitor_id
       WHERE a.workspace_id = $1
         AND ($2::text IS NULL OR a.link_slug = $2)
         AND ($3::text IS NULL OR a.status = $3)
         AND ($4::timestamptz IS NULL OR a.created_at >= $4)
         AND ($5::timestamptz IS NULL OR a.created_at < $5)
       ORDER BY a.created_at DESC LIMIT 1000`,
      [workspaceId, q.link ?? null, q.status ?? null, q.from ?? null, q.to ?? null],
    );
    if (q.format === "csv") {
      const cols = Object.keys(rows[0] ?? { id: "" });
      const csv = [
        cols.join(","),
        ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(",")),
      ].join("\n");
      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="pama-audit.csv"',
      });
    }
    return c.json({ items: rows });
  });
