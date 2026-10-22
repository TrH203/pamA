// Owner sessions on servers (US5): an httpOnly, SameSite=Lax cookie holding a random id whose
// hash is stored. Lax cookies are not sent on cross-site POSTs, and the API only accepts JSON.
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../app.ts";

export const SESSION_COOKIE = "pama_s";
const DAYS = 30;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createSession(c: Context<Env>, workspaceId: string, email: string) {
  const { db, config } = c.get("deps");
  const id = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO owner_sessions (id_hash, workspace_id, email, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    [hash(id), workspaceId, email, DAYS],
  );
  setCookie(c, SESSION_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: config.baseUrl.startsWith("https://"),
    maxAge: DAYS * 86_400,
  });
}

export async function ownerFromSession(
  c: Context<Env>,
): Promise<{ workspaceId: string; email: string } | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return null;
  const [s] = await c
    .get("deps")
    .db.query<{ workspace_id: string; email: string }>(
      "SELECT workspace_id, email FROM owner_sessions WHERE id_hash = $1 AND expires_at > now()",
      [hash(id)],
    );
  return s ? { workspaceId: s.workspace_id, email: s.email } : null;
}

export async function endSession(c: Context<Env>) {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await c.get("deps").db.query("DELETE FROM owner_sessions WHERE id_hash = $1", [hash(id)]);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
