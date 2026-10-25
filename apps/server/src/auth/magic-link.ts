// Email magic-link sign-in for the owner console on servers (US5, spec Assumptions). The login
// endpoint always answers 204 so it does not reveal who has an account.
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { body } from "../routes/util.ts";
import { assertLocalRequest, same, setLocalCookie } from "./local-token.ts";
import { createSession, endSession, ownerFromSession } from "./session.ts";

const MINUTES = 15;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export const authRoutes = new Hono<Env>()
  .post("/auth/local-session", async (c) => {
    const { config } = c.get("deps");
    if (config.mode !== "local") throw new HttpError(404, "not_found", "only used in local mode");
    assertLocalRequest(c);
    const { token } = await body(c, z.strictObject({ token: z.string().max(200) }));
    if (!same(token, config.localToken)) throw new HttpError(401, "unauthorized", "bad token");
    setLocalCookie(c, token);
    return c.body(null, 204);
  })
  .post("/auth/login", async (c) => {
    const { db, config, mailer, workspaceId } = c.get("deps");
    if (config.mode === "local") throw new HttpError(404, "not_found", "not used in local mode");
    if (!mailer.available) {
      throw new HttpError(
        503,
        "email_unavailable",
        "Email is not configured; use PAMA_OWNER_TOKEN instead.",
      );
    }
    const { email: raw, next } = await body(
      c,
      z.strictObject({
        email: z.email().max(320),
        /** Where to land after sign-in, e.g. the device approval page. Relative paths only. */
        next: z.string().max(500).optional(),
      }),
    );
    const email = raw.toLowerCase();
    let [ws] = await db.query<{ id: string }>("SELECT id FROM workspaces WHERE owner_email = $1", [
      email,
    ]);
    if (!ws && config.mode === "cloud") {
      // Sign-up: one workspace per email.
      const id = ulid();
      await db.query("INSERT INTO workspaces (id, owner_email, display_name) VALUES ($1, $2, $3)", [
        id,
        email,
        email.split("@")[0] ?? "the owner",
      ]);
      ws = { id };
    }
    if (!ws || (config.mode === "selfhost" && ws.id !== workspaceId)) return c.body(null, 204);
    const token = randomBytes(32).toString("base64url");
    await db.query(
      "INSERT INTO login_tokens (token_hash, email, workspace_id, expires_at, next) VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5)",
      [hash(token), email, ws.id, MINUTES, next && /^\/(?![/\\])/.test(next) ? next : null],
    );
    await mailer.send({
      to: email,
      subject: "Sign in to pamA",
      text: `Sign in to your pamA console:\n\n${config.baseUrl}/v1/auth/callback?token=${token}\n\nThe link works once and expires in ${MINUTES} minutes. If you did not ask for it, ignore this email.`,
    });
    return c.body(null, 204);
  })
  .get("/auth/callback", async (c) => {
    const { db } = c.get("deps");
    const token = c.req.query("token") ?? "";
    const [t] = await db.query<{ email: string; workspace_id: string; next: string | null }>(
      `UPDATE login_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email, workspace_id, next`,
      [hash(token)],
    );
    if (!t) throw new HttpError(410, "link_expired", "This sign-in link was used or has expired.");
    await createSession(c, t.workspace_id, t.email);
    return c.redirect(t.next ?? "/", 302);
  })
  .post("/auth/logout", async (c) => {
    await endSession(c);
    return c.body(null, 204);
  })
  .get("/auth/me", async (c) => {
    const s = await ownerFromSession(c);
    return c.json({
      email: s?.email ?? null,
      workspace_id: c.get("deps").workspaceId,
      mode: c.get("deps").config.mode,
      dev: process.env.PAMA_DEV === "1",
    });
  });
