// Outbound connections made by the server (FR-027): what strict offline mode allowed and blocked.
import { Hono } from "hono";
import type { Env } from "../app.ts";

export const networkLogRoutes = new Hono<Env>().get("/network-log", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
  const items = await c
    .get("deps")
    .db.query(
      "SELECT id, at, component, host, purpose, allowed FROM network_log ORDER BY at DESC, id DESC LIMIT $1",
      [limit],
    );
  return c.json({ items });
});
