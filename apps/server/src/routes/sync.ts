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
import { body } from "./util.ts";

export const syncRoutes = new Hono<Env>()
  .post("/sync/digests", async (c) => {
    const b = await body(c, SyncDigestSchema);
    return c.json(await ingestDigest(c.get("deps"), c.get("device").id, b));
  })
  .post("/sync/drafts", async (c) => {
    const b = await body(c, SyncDraftSchema);
    if (!c.get("device")) throw new HttpError(404, "not_found", "drafts come from paired devices");
    return c.json(await ingestDigest(c.get("deps"), c.get("device").id, b, "draft"));
  })
  .get("/sync/changes", async (c) =>
    c.json(await changesSince(c.get("deps"), c.req.query("since"))),
  )
  .post("/sync/tombstones", async (c) => {
    const b = await body(c, SyncTombstoneSchema);
    return c.json(await applyTombstone(c.get("deps"), c.get("device").id, b));
  });
