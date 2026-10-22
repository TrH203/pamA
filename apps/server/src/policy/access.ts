// Ask Link access (research R11): open, PIN, email one-time code, email/domain allowlist.
// 5 failed PIN/OTP attempts lock the visitor (cookie or IP) for 15 minutes. Visitors carry a
// signed, httpOnly cookie scoped to /a/<slug>.
import { randomInt } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { ulid } from "ulid";
import type { Deps, Env } from "../app.ts";
import { HttpError } from "../http.ts";
import type { ResolvedLink } from "./resolve-link.ts";
import { hashIp, hashSecret, sign, unsign, verifySecret } from "./secrets.ts";

export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;
export const OTP_MINUTES = 10;
const COOKIE = "pama_v";

export interface Visitor {
  id: string;
  email: string | null;
  verified_at: Date | null;
  granted_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
  otp_hash: string | null;
  otp_expires_at: Date | null;
}

function clientIp(c: Context<Env>): string {
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd && c.get("deps").config.mode !== "local") return fwd;
  try {
    return getConnInfo(c).remote.address ?? fwd ?? "unknown";
  } catch {
    return fwd ?? "unknown";
  }
}

function setVisitorCookie(c: Context<Env>, slug: string, id: string) {
  const { config } = c.get("deps");
  setCookie(c, COOKIE, sign(id, config.secret), {
    path: `/a/${slug}`,
    httpOnly: true,
    sameSite: "Lax",
    secure: config.baseUrl.startsWith("https://"),
    maxAge: 60 * 60 * 24 * 90,
  });
}

const COLS =
  "id, email, verified_at, granted_at, failed_attempts, locked_until, otp_hash, otp_expires_at";

/** The visitor of this request, identified by the signed cookie only. */
export async function findVisitor(
  c: Context<Env>,
  link: ResolvedLink,
): Promise<Visitor | undefined> {
  const { db, config } = c.get("deps");
  const raw = getCookie(c, COOKIE);
  const id = raw ? unsign(raw, config.secret) : null;
  if (!id) return undefined;
  const [v] = await db.query<Visitor>(
    `SELECT ${COLS} FROM visitors WHERE id = $1 AND link_slug = $2`,
    [id, link.slug],
  );
  return v;
}

/**
 * IP-level lockout: a new cookie must not reset the attempt counter. Any visitor from this IP that
 * is locked locks the IP for this link. IPs are never used to *grant* access.
 */
async function ipLocked(c: Context<Env>, link: ResolvedLink): Promise<boolean> {
  const { db, config } = c.get("deps");
  const [r] = await db.query<{ locked: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM visitors WHERE link_slug = $1 AND ip_hash = $2 AND locked_until > now()) AS locked`,
    [link.slug, hashIp(clientIp(c), config.secret)],
  );
  return r?.locked ?? false;
}

async function createVisitor(
  c: Context<Env>,
  link: ResolvedLink,
  granted: boolean,
): Promise<Visitor> {
  const { db, config } = c.get("deps");
  const [v] = await db.query<Visitor>(
    `INSERT INTO visitors (id, link_slug, ip_hash, granted_at) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
    [
      ulid(),
      link.slug,
      hashIp(clientIp(c), config.secret),
      granted ? new Date().toISOString() : null,
    ],
  );
  setVisitorCookie(c, link.slug, (v as Visitor).id);
  return v as Visitor;
}

function locked(v: Visitor): boolean {
  return v.locked_until !== null && new Date(v.locked_until).getTime() > Date.now();
}

async function fail(db: Deps["db"], v: Visitor): Promise<never> {
  const [r] = await db.query<{ failed_attempts: number }>(
    `UPDATE visitors SET failed_attempts = failed_attempts + 1,
       locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
     WHERE id = $1 RETURNING failed_attempts`,
    [v.id, MAX_FAILED, LOCK_MINUTES],
  );
  if ((r?.failed_attempts ?? 0) >= MAX_FAILED) {
    throw new HttpError(423, "locked", `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`);
  }
  throw new HttpError(401, "access_denied", "That did not match.");
}

/** Access gate for content endpoints. Open links grant a visitor on first contact. */
export async function requireAccess(c: Context<Env>, link: ResolvedLink): Promise<Visitor> {
  const v = await findVisitor(c, link);
  if (v?.granted_at && !locked(v)) {
    if (!getCookie(c, COOKIE)) setVisitorCookie(c, link.slug, v.id);
    return v;
  }
  if (link.accessMode === "open") return v ? v : createVisitor(c, link, true);
  c.header("x-pama-access", link.accessMode);
  throw new HttpError(401, "access_required", "Access is required for this link.");
}

function allowed(link: ResolvedLink, email: string): boolean {
  if (link.accessMode !== "allowlist") return true;
  const e = email.toLowerCase();
  const domain = e.split("@")[1] ?? "";
  return link.allowlist.some((a) => a === e || a === `*@${domain}`);
}

export interface AccessRequest {
  pin?: string;
  email?: string;
  otp?: string;
}

export async function grantAccess(
  c: Context<Env>,
  link: ResolvedLink,
  req: AccessRequest,
): Promise<void> {
  const { db, mailer } = c.get("deps");
  if (link.accessMode !== "open" && (await ipLocked(c, link))) {
    throw new HttpError(423, "locked", `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`);
  }
  const v =
    (await findVisitor(c, link)) ?? (await createVisitor(c, link, link.accessMode === "open"));
  if (locked(v))
    throw new HttpError(423, "locked", `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`);

  switch (link.accessMode) {
    case "open":
      await db.query("UPDATE visitors SET granted_at = COALESCE(granted_at, now()) WHERE id = $1", [
        v.id,
      ]);
      setVisitorCookie(c, link.slug, v.id);
      return;
    case "pin": {
      if (!req.pin || !link.pinHash || !verifySecret(req.pin, link.pinHash)) return fail(db, v);
      await db.query("UPDATE visitors SET granted_at = now(), failed_attempts = 0 WHERE id = $1", [
        v.id,
      ]);
      setVisitorCookie(c, link.slug, v.id);
      return;
    }
    case "email_otp":
    case "allowlist": {
      const email = req.email?.trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new HttpError(422, "invalid_request", "A valid email address is required.");
      }
      if (!allowed(link, email))
        throw new HttpError(401, "not_allowed", "This email is not allowed for this link.");
      if (!req.otp) {
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        await db.query(
          `UPDATE visitors SET email = $2, otp_hash = $3, otp_expires_at = now() + make_interval(mins => $4) WHERE id = $1`,
          [v.id, email, hashSecret(code), OTP_MINUTES],
        );
        await mailer.send({
          to: email,
          subject: `Your code for "${link.title}"`,
          text: `Your pamA code is ${code}. It expires in ${OTP_MINUTES} minutes.\n\nIf you did not ask for it, ignore this email.`,
        });
        return;
      }
      const fresh = v.otp_expires_at && new Date(v.otp_expires_at).getTime() > Date.now();
      if (v.email !== email || !v.otp_hash || !fresh || !verifySecret(req.otp, v.otp_hash))
        return fail(db, v);
      await db.query(
        `UPDATE visitors SET verified_at = now(), granted_at = now(), failed_attempts = 0, otp_hash = NULL WHERE id = $1`,
        [v.id],
      );
      setVisitorCookie(c, link.slug, v.id);
      return;
    }
  }
}
