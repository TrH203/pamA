// One place decides who may call what under /v1:
//   public  : /v1/health, /v1/devices/pair
//   device  : /v1/sync/digests, /v1/sync/tombstones (device token on servers; local token locally)
//   owner   : everything else (local token on the owner's machine; owner token on servers,
//             plus the email sign-in session added in US5)
import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { deviceForToken } from "./device.ts";
import { localToken } from "./local-token.ts";
import { ownerFromSession } from "./session.ts";

const PUBLIC = new Set(["/v1/health", "/v1/devices/pair"]);
const DEVICE = new Set(["/v1/sync/digests", "/v1/sync/tombstones"]);
/** Only the owner's own machine may receive transcripts or hand out sync work (Constitution I). */
const LOCAL_ONLY = new Set(["/v1/transcripts/digest", "/v1/sync/pending", "/v1/sync/ack"]);

function bearer(h: string | undefined): string {
  return h?.startsWith("Bearer ") ? h.slice(7) : "";
}

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function authenticate(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const { config, db } = c.get("deps");
    const path = c.req.path;
    if (PUBLIC.has(path)) return next();
    if (config.mode === "local") return localToken(config.localToken)(c, next);
    if (LOCAL_ONLY.has(path)) {
      throw new HttpError(
        403,
        "local_only",
        "only accepted by the local server on the owner's machine",
      );
    }

    const token = bearer(c.req.header("authorization"));
    if (DEVICE.has(path)) {
      const device = token ? await deviceForToken(db, token) : null;
      if (!device) throw new HttpError(401, "unauthorized", "unknown or revoked device");
      c.set("device", device);
      return next();
    }
    if (config.ownerToken && token && same(token, config.ownerToken)) return next();
    if (await ownerFromSession(c)) return next();
    throw new HttpError(401, "unauthorized", "sign in required");
  };
}
