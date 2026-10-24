// Device login (spec 004, research R1): an RFC 8628-style device authorization grant. The CLI
// starts a request and polls with the secret device code; the owner signs in to the console and
// approves the short user code. The device token is handed out once, then forgotten.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { body } from "../routes/util.ts";
import { hashSecret, newDeviceToken } from "./device.ts";

const MINUTES = 10;
const INTERVAL_S = 2;
const CONSOLE_LINK_MINUTES = 5;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** `abcd-efgh` → `ABCDEFGH`. */
const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const show = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

const UserCode = z.strictObject({ user_code: z.string().min(4).max(20) });

interface Request {
  status: "pending" | "approved" | "denied" | "consumed";
  device_name: string;
  expired: boolean;
  created_at: string;
}

function notLocal(c: { get(k: "deps"): Env["Variables"]["deps"] }) {
  if (c.get("deps").config.mode === "local") {
    throw new HttpError(404, "not_found", "device login is only used with remote servers");
  }
}

async function pendingRequest(
  db: Env["Variables"]["deps"]["db"],
  userCode: string,
): Promise<Request & { device_code_hash: string }> {
  const [r] = await db.query<Request & { device_code_hash: string }>(
    `SELECT device_code_hash, status, device_name, created_at, expires_at <= now() AS expired
     FROM device_auth_requests WHERE user_code = $1`,
    [normalize(userCode)],
  );
  if (!r) throw new HttpError(404, "not_found", "Unknown code.");
  if (r.expired) throw new HttpError(410, "expired_token", "This code has expired.");
  if (r.status !== "pending")
    throw new HttpError(409, "conflict", `This code was already ${r.status}.`);
  return r;
}

export const deviceFlowRoutes = new Hono<Env>()
  .post("/auth/device/start", async (c) => {
    notLocal(c);
    const { db, config } = c.get("deps");
    const { device_name } = await body(
      c,
      z.strictObject({ device_name: z.string().trim().min(1).max(100) }),
    );
    const deviceCode = randomBytes(32).toString("base64url");
    // Retry on the rare user-code collision.
    for (let attempt = 0; ; attempt++) {
      const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      try {
        await db.query(
          `INSERT INTO device_auth_requests (device_code_hash, user_code, device_name, expires_at)
           VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
          [sha(deviceCode), code, device_name, MINUTES],
        );
      } catch (e) {
        if (attempt < 3) continue;
        throw e;
      }
      const uri = `${config.baseUrl}/`;
      return c.json({
        device_code: deviceCode,
        user_code: show(code),
        verification_uri: uri,
        verification_uri_complete: `${uri}?device=${show(code)}`,
        interval: INTERVAL_S,
        expires_in: MINUTES * 60,
      });
    }
  })
  .post("/auth/device/token", async (c) => {
    notLocal(c);
    const { db, config } = c.get("deps");
    const { device_code } = await body(
      c,
      z.strictObject({ device_code: z.string().min(1).max(200) }),
    );
    // Hand the token out once: the UPDATE clears it in the same statement.
    const [done] = await db.query<{ token: string; device_id: string; workspace_id: string }>(
      `UPDATE device_auth_requests r SET status = 'consumed', token_once = NULL
       FROM (SELECT device_code_hash, token_once FROM device_auth_requests
             WHERE device_code_hash = $1 AND status = 'approved' AND expires_at > now() FOR UPDATE) old
       WHERE r.device_code_hash = old.device_code_hash
       RETURNING old.token_once AS token, r.device_id, r.workspace_id`,
      [sha(device_code)],
    );
    if (done) {
      return c.json({
        token: done.token,
        device_id: done.device_id,
        workspace_id: done.workspace_id,
        server_version: config.version,
      });
    }
    const [r] = await db.query<{ status: string; expired: boolean }>(
      "SELECT status, expires_at <= now() AS expired FROM device_auth_requests WHERE device_code_hash = $1",
      [sha(device_code)],
    );
    if (!r || r.expired || r.status === "consumed" || r.status === "approved") {
      throw new HttpError(410, "expired_token", "This login request has expired; start again.");
    }
    if (r.status === "denied") throw new HttpError(403, "access_denied", "The login was denied.");
    throw new HttpError(428, "authorization_pending", "Waiting for approval in the browser.");
  })
  .get("/auth/device/lookup", async (c) => {
    notLocal(c);
    const r = await pendingRequest(c.get("deps").db, c.req.query("code") ?? "");
    return c.json({
      user_code: show(normalize(c.req.query("code") ?? "")),
      device_name: r.device_name,
      created_at: r.created_at,
      status: r.status,
    });
  })
  .post("/auth/device/approve", async (c) => {
    notLocal(c);
    const { db, workspaceId } = c.get("deps");
    const { user_code } = await body(c, UserCode);
    const r = await pendingRequest(db, user_code);
    const { token, prefix } = newDeviceToken();
    const id = ulid();
    await db.tx(async (q) => {
      const rows = await q.query(
        `UPDATE device_auth_requests SET status = 'approved', workspace_id = $2, device_id = $3, token_once = $4
         WHERE device_code_hash = $1 AND status = 'pending' RETURNING 1`,
        [r.device_code_hash, workspaceId, id, token],
      );
      if (!rows.length) throw new HttpError(409, "conflict", "This code was already decided.");
      await q.query(
        "INSERT INTO devices (id, workspace_id, name, token_hash, token_prefix) VALUES ($1, $2, $3, $4, $5)",
        [id, workspaceId, r.device_name, hashSecret(token), prefix],
      );
    });
    return c.json({ device_id: id });
  })
  .post("/auth/device/deny", async (c) => {
    notLocal(c);
    const { db } = c.get("deps");
    const { user_code } = await body(c, UserCode);
    const r = await pendingRequest(db, user_code);
    await db.query(
      "UPDATE device_auth_requests SET status = 'denied' WHERE device_code_hash = $1",
      [r.device_code_hash],
    );
    return c.body(null, 204);
  })
  .post("/auth/device/console-link", async (c) => {
    notLocal(c);
    const { db, config, workspaceId } = c.get("deps");
    if (!c.get("device"))
      throw new HttpError(403, "forbidden", "only devices ask for console links");
    const [ws] = await db.query<{ email: string | null }>(
      "SELECT owner_email AS email FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    if (!ws?.email) {
      throw new HttpError(
        409,
        "no_owner_email",
        "This workspace has no owner email to sign in with.",
      );
    }
    const token = randomBytes(32).toString("base64url");
    await db.query(
      "INSERT INTO login_tokens (token_hash, email, workspace_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))",
      [sha(token), ws.email, workspaceId, CONSOLE_LINK_MINUTES],
    );
    return c.json({ url: `${config.baseUrl}/v1/auth/callback?token=${token}` });
  });
