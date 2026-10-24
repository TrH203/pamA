// One place decides who may call what under /v1:
//   public  : /v1/health, /v1/devices/pair, device login start/poll
//   device  : /v1/sync/*, console links (device token on servers; local token locally)
//   owner   : everything else (local token on the owner's machine; owner token on servers,
//             the email sign-in session added in US5, or a device token acting as the owner
//             of its workspace — the thin client, spec 004)
import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { modelsFor } from "../llm/workspace-models.ts";
import { deviceForToken } from "./device.ts";
import { localToken } from "./local-token.ts";
import { ownerFromSession } from "./session.ts";

const PUBLIC = new Set([
  "/v1/health",
  "/v1/devices/pair",
  "/v1/auth/login",
  "/v1/auth/callback",
  "/v1/auth/local-session",
  "/v1/auth/device/start",
  "/v1/auth/device/token",
]);
const DEVICE = new Set([
  "/v1/sync/digests",
  "/v1/sync/tombstones",
  "/v1/sync/drafts",
  "/v1/sync/changes",
  "/v1/auth/device/console-link",
]);
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
    const deps = c.get("deps");
    // Requests act in one workspace: the device's, the signed-in owner's, or (owner token) the
    // server's default workspace.
    // Cloud: a workspace may answer with its own chat model (FR-026).
    const as = async (workspaceId: string) => {
      c.set("deps", { ...deps, workspaceId, models: await modelsFor(deps, workspaceId) });
      c.set("actor", "workspace");
    };
    if (DEVICE.has(path)) {
      const device = token ? await deviceForToken(db, token) : null;
      if (!device) throw new HttpError(401, "unauthorized", "unknown or revoked device");
      c.set("device", device);
      await as(device.workspace_id);
      return next();
    }
    if (config.ownerToken && token && same(token, config.ownerToken)) {
      c.set("actor", "operator");
      return next();
    }
    if (token.startsWith("pd_")) {
      const device = await deviceForToken(db, token);
      if (!device) throw new HttpError(401, "unauthorized", "unknown or revoked device");
      c.set("device", device);
      await as(device.workspace_id);
      return next();
    }
    const session = await ownerFromSession(c);
    if (session) {
      await as(session.workspaceId);
      return next();
    }
    throw new HttpError(401, "unauthorized", "sign in required");
  };
}
