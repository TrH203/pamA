// Owner endpoints for Ask Links: suggestions, create, list, read, update, revoke.
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { suggestSources } from "../pipeline/suggest.ts";
import {
  createLink,
  LinkPatchSchema,
  listLinks,
  patchLink,
  revokeLink,
} from "../services/links.ts";
import { body } from "./util.ts";

export const linkRoutes = new Hono<Env>()
  .post("/suggest", async (c) => {
    const { query } = await body(c, z.strictObject({ query: z.string().min(1).max(500) }));
    return c.json({ sources: await suggestSources(c.get("deps"), query) });
  })
  .post("/links", async (c) => {
    const raw = await c.req.json().catch(() => {
      throw new HttpError(422, "invalid_request", "body must be JSON");
    });
    return c.json(await createLink(c.get("deps"), raw), 201);
  })
  .get("/links", async (c) => c.json({ items: await listLinks(c.get("deps")) }))
  .get("/links/:slug", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const [l] = await db.query(
      `SELECT slug, title, source_refs, detail, deny_labels, deny_topics, instruction, access_mode, allowlist,
              rate_limit_per_hour, expires_at, revoked_at, footer_enabled, created_at
       FROM ask_links WHERE slug = $1 AND workspace_id = $2`,
      [c.req.param("slug"), workspaceId],
    );
    if (!l) throw new HttpError(404, "not_found", "link not found");
    const questions = await db.query(
      "SELECT text, rank, edited_by_owner FROM suggested_questions WHERE link_slug = $1 ORDER BY rank",
      [c.req.param("slug")],
    );
    return c.json({
      ...l,
      suggested_questions: questions,
      url: `${c.get("deps").config.baseUrl}/a/${c.req.param("slug")}`,
    });
  })
  .patch("/links/:slug", async (c) => {
    await patchLink(c.get("deps"), c.req.param("slug"), await body(c, LinkPatchSchema));
    return c.json({ slug: c.req.param("slug") });
  })
  .post("/links/:slug/revoke", async (c) => {
    await revokeLink(c.get("deps"), c.req.param("slug"));
    return c.body(null, 204);
  });
