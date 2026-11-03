// On the owner's machine: sync status, what the device worker should send, and its receipts.
// /v1/sync/pending and /v1/sync/ack exist only on the local server (auth/index.ts: local_only).
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { listBundles } from "../services/bundles.ts";
import { ack, bundleKey, bundleRef, pending } from "../services/sync.ts";
import { body } from "./util.ts";

export const syncLocalRoutes = new Hono<Env>()
  .get("/sync/status", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const projects = await db.query<{
      id: string;
      name: string;
      repo_key: string;
      sync_enabled: boolean;
      sync_target: string | null;
    }>(
      "SELECT id, name, repo_key, sync_enabled, sync_target FROM projects WHERE workspace_id = $1 ORDER BY name",
      [workspaceId],
    );
    const bundles = await db.query<{
      id: string;
      project_id: string;
      name: string;
      name_source: string;
      key: string | null;
      sync_enabled: boolean | null;
    }>(
      "SELECT id, project_id, name, name_source, key, sync_enabled FROM bundles WHERE workspace_id = $1 ORDER BY name",
      [workspaceId],
    );
    const summaries = new Map((await listBundles(db, workspaceId)).map((b) => [b.id, b]));
    const p = await pending(c.get("deps"));
    return c.json({
      projects: projects.map((x) => ({
        ...x,
        bundles: bundles
          .filter((b) => b.project_id === x.id)
          .map((b) => ({
            ...b,
            branches: summaries.get(b.id)?.branches ?? [],
            session_count: summaries.get(b.id)?.session_count ?? 0,
            last_activity: summaries.get(b.id)?.last_activity ?? null,
          })),
      })),
      pending: { digests: p.digests.length, tombstones: p.tombstones.length },
    });
  })
  .get("/sync/pending", async (c) => c.json(await pending(c.get("deps"))))
  .post("/sync/ack", async (c) => {
    const a = await body(
      c,
      z.strictObject({
        digests: z.array(z.strictObject({ digest_id: z.string(), target: z.string() })).max(1000),
        tombstones: z.array(z.string()).max(1000),
        bundle_changes: z.array(z.string()).max(1000).optional(),
      }),
    );
    await ack(c.get("deps"), a);
    return c.json({ ok: true });
  })
  // Where a project's or task's published copy lives and its portable key there (masked like
  // the tombstone that turning publish off would send), so the device can ask the target which
  // Ask Links would lose sources (spec 007).
  .get("/sync/source", async (c) => {
    const deps = c.get("deps");
    const type = c.req.query("type");
    const id = c.req.query("id") ?? "";
    const mask = (t: string) => deps.rules.redact(t).text;
    if (type === "project") {
      const [p] = await deps.db.query<{ repo_key: string; sync_target: string | null }>(
        "SELECT repo_key, sync_target FROM projects WHERE id = $1 AND workspace_id = $2",
        [id, deps.workspaceId],
      );
      if (!p) throw new HttpError(404, "not_found", "project not found");
      return c.json({ target: p.sync_target, source_type: "project", source_key: p.repo_key });
    }
    if (type === "bundle") {
      const [b] = await deps.db.query<{
        key: string | null;
        repo_key: string;
        sync_target: string | null;
      }>(
        `SELECT b.key, p.repo_key, p.sync_target FROM bundles b JOIN projects p ON p.id = b.project_id
         WHERE b.id = $1 AND b.workspace_id = $2`,
        [id, deps.workspaceId],
      );
      if (!b) throw new HttpError(404, "not_found", "bundle not found");
      return c.json({
        target: b.sync_target,
        source_type: "bundle",
        source_key: mask(bundleKey(b.repo_key, bundleRef({ id, key: b.key }))),
      });
    }
    throw new HttpError(422, "invalid_request", "type must be project or bundle");
  });
