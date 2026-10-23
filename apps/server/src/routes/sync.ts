// Receiving server: deliveries from paired devices (device token, auth/index.ts).
import { Hono } from "hono";
import type { Env } from "../app.ts";
import {
  applyTombstone,
  ingestDigest,
  SyncDigestSchema,
  SyncTombstoneSchema,
} from "../services/sync.ts";
import { body } from "./util.ts";

export const syncRoutes = new Hono<Env>()
  .post("/sync/digests", async (c) => {
    const b = await body(c, SyncDigestSchema);
    return c.json(await ingestDigest(c.get("deps"), c.get("device").id, b));
  })
  .post("/sync/tombstones", async (c) => {
    const b = await body(c, SyncTombstoneSchema);
    return c.json(await applyTombstone(c.get("deps"), c.get("device").id, b));
  });
