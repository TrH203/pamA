// Local mode: the console and device API are reachable only on loopback and require the
// per-launch token that the desktop app / CLI received when it started the server.
import { timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";
import { HttpError } from "../http.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function localToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    let addr: string | undefined;
    try {
      addr = getConnInfo(c).remote.address;
    } catch {
      addr = undefined; // in-process requests (tests) have no socket
    }
    if (addr !== undefined && !LOOPBACK.has(addr)) {
      throw new HttpError(403, "loopback_only", "owner API is only available on this machine");
    }
    const auth = c.req.header("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!given || !same(given, token))
      throw new HttpError(401, "unauthorized", "missing or bad token");
    await next();
  };
}
