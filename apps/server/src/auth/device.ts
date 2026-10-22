// Device tokens (US4): `pd_<8-char prefix>_<secret>`, stored as a scrypt hash; the prefix finds
// the row without scanning every hash. Revoked devices are rejected.
import { randomBytes } from "node:crypto";
import type { Queryable } from "../db/client.ts";
import { hashSecret, verifySecret } from "../policy/secrets.ts";

export function newDeviceToken(): { token: string; prefix: string } {
  const prefix = randomBytes(6).toString("base64url").slice(0, 8);
  return { token: `pd_${prefix}_${randomBytes(24).toString("base64url")}`, prefix };
}

export interface Device {
  id: string;
  workspace_id: string;
  name: string;
}

export async function deviceForToken(q: Queryable, token: string): Promise<Device | null> {
  const m = /^pd_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{20,}$/.exec(token);
  if (!m) return null;
  const rows = await q.query<Device & { token_hash: string }>(
    "SELECT id, workspace_id, name, token_hash FROM devices WHERE token_prefix = $1 AND revoked_at IS NULL",
    [m[1]],
  );
  const d = rows.find((r) => verifySecret(token, r.token_hash));
  if (!d) return null;
  await q.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [d.id]);
  return { id: d.id, workspace_id: d.workspace_id, name: d.name };
}

export { hashSecret };
