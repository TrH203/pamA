// Receiving server: deliveries from paired devices (device token, auth/index.ts), drafts from
// thin-client devices and the review decisions they pull back (spec 004).
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import {
  applyTombstone,
  changesSince,
  ingestDigest,
  SyncDigestSchema,
  SyncDraftSchema,
  SyncTombstoneSchema,
} from "../services/sync.ts";
import { tracked } from "./activity.ts";
import { body } from "./util.ts";

export const syncRoutes = new Hono<Env>()
  .post("/sync/digests", async (c) => {
    const b = await body(c, SyncDigestSchema);
    return c.json(await ingestDigest(c.get("deps"), c.get("device").id, b));
  })
  .post("/sync/drafts", async (c) => {
    const b = await body(c, SyncDraftSchema);
    if (!c.get("device")) throw new HttpError(404, "not_found", "drafts come from paired devices");
    const src = (b.digest as { source?: Record<string, unknown> } | null)?.source ?? {};
    const who = {
      kind: "draft" as const,
      agent: String(src.agent ?? "unknown"),
      agent_session_id: String(src.agent_session_id ?? "unknown"),
      project_key: typeof src.project_key === "string" ? src.project_key : null,
    };
    return c.json(
      await tracked(c, who, (run) =>
        ingestDigest(c.get("deps"), c.get("device").id, b, "draft", run),
      ),
    );
  })
  .get("/sync/changes", async (c) =>
    c.json(await changesSince(c.get("deps"), c.req.query("since"))),
  )
  .post("/sync/tombstones", async (c) => {
    const b = await body(c, SyncTombstoneSchema);
    return c.json(await applyTombstone(c.get("deps"), c.get("device").id, b));
  });
