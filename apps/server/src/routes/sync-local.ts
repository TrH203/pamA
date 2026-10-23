// On the owner's machine: sync status, what the device worker should send, and its receipts.
// /v1/sync/pending and /v1/sync/ack exist only on the local server (auth/index.ts: local_only).
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { listBundles } from "../services/bundles.ts";
import { ack, pending } from "../services/sync.ts";
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
      }),
    );
    await ack(c.get("deps"), a);
    return c.json({ ok: true });
  });
