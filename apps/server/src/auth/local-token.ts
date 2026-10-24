// Local mode: the console and device API are reachable only on loopback and require the
// per-launch token that the desktop app / CLI received when it started the server. Programmatic
// clients send it as a bearer token; the browser console trades it once for an httpOnly cookie
// (`POST /v1/auth/local-session`) so new tabs and reloads need no paste.
import { timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HttpError } from "../http.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const LOCAL_COOKIE = "pama_l";

export function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Loopback peer and a loopback `Host` header (a rebound DNS name arrives with its own Host). */
export function assertLocalRequest(c: Context): void {
  let addr: string | undefined;
  try {
    addr = getConnInfo(c).remote.address;
  } catch {
    addr = undefined; // in-process requests (tests) have no socket
  }
  if (addr !== undefined && !LOOPBACK.has(addr)) {
    throw new HttpError(403, "loopback_only", "owner API is only available on this machine");
  }
  const host = (c.req.header("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  if (host && !LOOPBACK_HOSTS.has(host)) {
    throw new HttpError(403, "bad_host", "use http://127.0.0.1 to reach the local console");
  }
}

export function localToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    assertLocalRequest(c);
    const auth = c.req.header("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (given && same(given, token)) return next();
    // Cookie auth is ambient, so it also needs a same-origin request (CSRF).
    const cookie = getCookie(c, LOCAL_COOKIE) ?? "";
    if (cookie && same(cookie, token)) {
      const origin = c.req.header("origin");
      if (origin && new URL(origin).host !== c.req.header("host")) {
        throw new HttpError(403, "bad_origin", "cross-origin request refused");
      }
      return next();
    }
    throw new HttpError(401, "unauthorized", "missing or bad token");
  };
}

export function setLocalCookie(c: Context, token: string): void {
  setCookie(c, LOCAL_COOKIE, token, { path: "/", httpOnly: true, sameSite: "Strict" });
}
