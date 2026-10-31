// Receiving server: deliveries from paired devices (device token, auth/index.ts), drafts from
// thin-client devices and the review decisions they pull back (spec 004).
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import {
  affectedLinks,
  applyBundleChange,
  applyTombstone,
  changesSince,
  ingestDigest,
  SyncBundleChangeSchema,
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
  })
  // Task (bundle) rename/split/merge from the owner's machine (spec 007).
  .post("/sync/bundles", async (c) => {
    const b = await body(c, SyncBundleChangeSchema);
    return c.json(await applyBundleChange(c.get("deps"), c.get("device").id, b));
  })
  // Before turning sync off: the Ask Links here that would lose sources (spec 007).
  .get("/sync/affected-links", async (c) => {
    const type = z.enum(["project", "bundle", "session"]).safeParse(c.req.query("source_type"));
    const key = c.req.query("source_key") ?? "";
    if (!type.success || !key || key.length > 600)
      throw new HttpError(422, "invalid_request", "give source_type and source_key");
    return c.json({ links: await affectedLinks(c.get("deps"), type.data, key) });
  });
