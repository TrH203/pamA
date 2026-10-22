// Pairing (US4): the owner creates a one-time code in the console; the device exchanges it for a
// token (stored in the device's OS keychain). Owners can list and revoke devices.
import { createHash, randomInt } from "node:crypto";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import type { Env } from "../app.ts";
import { hashSecret, newDeviceToken } from "../auth/device.ts";
import { HttpError } from "../http.ts";
import { body } from "./util.ts";

const CODE_MINUTES = 10;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeHash = (code: string) =>
  createHash("sha256").update(code.toUpperCase().replaceAll("-", "")).digest("hex");

export const devicesRoutes = new Hono<Env>()
  .post("/devices/pairing-code", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    const expires = new Date(Date.now() + CODE_MINUTES * 60_000);
    await db.query(
      "INSERT INTO pairing_codes (code_hash, workspace_id, expires_at) VALUES ($1, $2, $3)",
      [codeHash(raw), workspaceId, expires.toISOString()],
    );
    return c.json({
      code: `${raw.slice(0, 4)}-${raw.slice(4)}`,
      expires_at: expires.toISOString(),
    });
  })
  .post("/devices/pair", async (c) => {
    const { db } = c.get("deps");
    const p = await body(
      c,
      z.strictObject({ code: z.string().min(4).max(20), device_name: z.string().min(1).max(100) }),
    );
    const [code] = await db.query<{ workspace_id: string }>(
      `UPDATE pairing_codes SET used_at = now()
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING workspace_id`,
      [codeHash(p.code)],
    );
    if (!code) {
      const [seen] = await db.query("SELECT 1 FROM pairing_codes WHERE code_hash = $1", [
        codeHash(p.code),
      ]);
      if (seen)
        throw new HttpError(410, "code_expired", "This pairing code was used or has expired.");
      throw new HttpError(400, "invalid_code", "Unknown pairing code.");
    }
    const { token, prefix } = newDeviceToken();
    const id = ulid();
    await db.query(
      "INSERT INTO devices (id, workspace_id, name, token_hash, token_prefix) VALUES ($1, $2, $3, $4, $5)",
      [id, code.workspace_id, p.device_name, hashSecret(token), prefix],
    );
    return c.json({ device_id: id, token });
  })
  .get("/devices", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const items = await db.query(
      "SELECT id, name, last_seen_at, revoked_at, created_at FROM devices WHERE workspace_id = $1 ORDER BY created_at",
      [workspaceId],
    );
    return c.json({ items });
  })
  .post("/devices/:id/revoke", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const rows = await db.query(
      "UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND workspace_id = $2 RETURNING id",
      [c.req.param("id"), workspaceId],
    );
    if (!rows.length) throw new HttpError(404, "not_found", "device not found");
    return c.body(null, 204);
  });
