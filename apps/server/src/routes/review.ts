// Owner review: drafts, approve/edit/discard/withdraw, projects (auto-approve), bundles.
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { listBundles, mergeBundles, renameBundle, splitBundle } from "../services/bundles.ts";
import { approveDigest, discardDigest, withdrawDigest } from "../services/digests.ts";
import { setBundleSync, setProjectSync } from "../services/sync.ts";
import { body } from "./util.ts";

export const reviewRoutes = new Hono<Env>()
  .get("/review", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const items = await db.query(
      `SELECT d.id, d.session_id, d.version, d.status, d.content, d.created_at,
              p.id AS project_id, p.name AS project, b.id AS bundle_id, b.name AS bundle
       FROM digests d JOIN sessions s ON s.id = d.session_id
       JOIN projects p ON p.id = s.project_id JOIN bundles b ON b.id = s.bundle_id
       WHERE d.workspace_id = $1 AND d.status = 'draft'
       ORDER BY d.created_at DESC, d.id DESC LIMIT 200`,
      [workspaceId],
    );
    return c.json({ items });
  })
  .get("/digests/:id", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const [d] = await db.query(
      "SELECT id, session_id, version, status, content, created_at, approved_at FROM digests WHERE id = $1 AND workspace_id = $2",
      [c.req.param("id"), workspaceId],
    );
    if (!d) throw new HttpError(404, "not_found", "digest not found");
    return c.json(d);
  })
  .post("/digests/:id/approve", async (c) => {
    const { content } = await body(c, z.object({ content: z.unknown().optional() }));
    return c.json(await approveDigest(c.get("deps"), c.req.param("id"), content));
  })
  .post("/digests/:id/discard", async (c) => {
    await discardDigest(c.get("deps"), c.req.param("id"));
    return c.json({ status: "discarded" });
  })
  .post("/digests/:id/withdraw", async (c) => {
    await withdrawDigest(c.get("deps"), c.req.param("id"));
    return c.json({ status: "withdrawn" });
  })
  .get("/projects", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const items = await db.query(
      "SELECT id, name, repo_key, auto_approve, sync_enabled, sync_target FROM projects WHERE workspace_id = $1 ORDER BY name",
      [workspaceId],
    );
    return c.json({ items });
  })
  .get("/projects/:id", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const [p] = await db.query(
      "SELECT id, name, repo_key, auto_approve, sync_enabled, sync_target FROM projects WHERE id = $1 AND workspace_id = $2",
      [c.req.param("id"), workspaceId],
    );
    if (!p) throw new HttpError(404, "not_found", "project not found");
    return c.json(p);
  })
  .patch("/projects/:id", async (c) => {
    const deps = c.get("deps");
    const patch = await body(
      c,
      z.strictObject({
        name: z.string().min(1).max(200).optional(),
        auto_approve: z.boolean().nullable().optional(),
        sync_enabled: z.boolean().optional(),
        sync_target: z.url().nullable().optional(),
      }),
    );
    const id = c.req.param("id");
    const [p] = await deps.db.query(
      `UPDATE projects SET
         name = COALESCE($3, name),
         auto_approve = CASE WHEN $4::boolean THEN $5::boolean ELSE auto_approve END
       WHERE id = $1 AND workspace_id = $2
       RETURNING id`,
      [
        id,
        deps.workspaceId,
        patch.name ?? null,
        "auto_approve" in patch,
        patch.auto_approve ?? null,
      ],
    );
    if (!p) throw new HttpError(404, "not_found", "project not found");
    if (patch.sync_enabled !== undefined)
      await setProjectSync(deps, id, patch.sync_enabled, patch.sync_target);
    else if (patch.sync_target !== undefined) {
      await deps.db.query("UPDATE projects SET sync_target = $2 WHERE id = $1", [
        id,
        patch.sync_target,
      ]);
    }
    const [out] = await deps.db.query(
      "SELECT id, name, repo_key, auto_approve, sync_enabled, sync_target FROM projects WHERE id = $1",
      [id],
    );
    return c.json(out);
  })
  .get("/bundles", async (c) => {
    const { db, workspaceId } = c.get("deps");
    return c.json({ items: await listBundles(db, workspaceId) });
  })
  .patch("/bundles/:id", async (c) => {
    const deps = c.get("deps");
    const patch = await body(
      c,
      z.strictObject({
        name: z.string().min(1).max(200).optional(),
        sync_enabled: z.boolean().nullable().optional(),
        sync_target: z.url().optional(),
      }),
    );
    const id = c.req.param("id");
    if (patch.name) await renameBundle(deps.db, deps.workspaceId, id, patch.name);
    if (patch.sync_enabled !== undefined)
      await setBundleSync(deps, id, patch.sync_enabled, patch.sync_target);
    return c.json({ id, ...patch });
  })
  .post("/bundles/merge", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const m = await body(
      c,
      z.strictObject({ bundle_ids: z.array(z.string()).min(2), name: z.string().min(1).max(200) }),
    );
    return c.json({ id: await mergeBundles(db, workspaceId, m.bundle_ids, m.name) });
  })
  .post("/bundles/:id/split", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const s = await body(
      c,
      z.strictObject({
        session_ids: z.array(z.string()).min(1),
        new_name: z.string().min(1).max(200),
      }),
    );
    return c.json({
      id: await splitBundle(db, workspaceId, c.req.param("id"), s.session_ids, s.new_name),
    });
  });
