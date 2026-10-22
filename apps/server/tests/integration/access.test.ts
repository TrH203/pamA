import { afterEach, beforeEach, expect, it } from "vitest";
import { createLink } from "../../src/services/links.ts";
import { type Seeded, seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";
import { visitor } from "../helpers/public.ts";

describeEachDb("Ask Link access", (f) => {
  let t: TestCtx;
  let s: Seeded;
  beforeEach(async () => {
    t = await makeCtx(f);
    s = await seed(t.deps);
  });
  afterEach(() => t.close());

  const link = (over: Record<string, unknown>) =>
    createLink(t.deps, {
      title: "Refunds",
      sources: [{ type: "bundle", id: s.bundleRefund }],
      ...over,
    });

  it("PIN: content only after the right PIN; cookie scoped to the link", async () => {
    const l = await link({ access_mode: "pin", pin: "4821" });
    const v = visitor(t, l.slug);
    expect((await v.call("/api/meta")).status).toBe(401);
    expect((await v.call("/api/access", { pin: "0000" })).status).toBe(401);
    const ok = await v.call("/api/access", { pin: "4821" });
    expect(ok.status).toBe(204);
    const raw = ok.headers.get("set-cookie") ?? "";
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toContain(`Path=/a/${l.slug}`);
    const meta = await v.call("/api/meta");
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as { title: string; suggested_questions: string[] };
    expect(body.title).toBe("Refunds");
    expect(body.suggested_questions.length).toBeGreaterThanOrEqual(3);
  });

  it("PIN: 5 wrong attempts lock the visitor for 15 minutes", async () => {
    const l = await link({ access_mode: "pin", pin: "4821" });
    const v = visitor(t, l.slug);
    for (let i = 0; i < 5; i++) await v.call("/api/access", { pin: "1111" });
    const locked = await v.call("/api/access", { pin: "4821" });
    expect(locked.status).toBe(423);
    const [row] = await t.db.query<{ minutes: number }>(
      "SELECT round(extract(epoch FROM locked_until - now()) / 60)::int AS minutes FROM visitors WHERE link_slug = $1",
      [l.slug],
    );
    expect(row?.minutes).toBe(15);
    // Another visitor (other IP, no cookie) is not affected.
    expect(
      (await visitor(t, l.slug, "198.51.100.9").call("/api/access", { pin: "4821" })).status,
    ).toBe(204);
  });

  it("email OTP: a 6-digit code by email, 5 attempts", async () => {
    const l = await link({ access_mode: "email_otp" });
    const v = visitor(t, l.slug);
    expect((await v.call("/api/access", { email: "qa@acme.vn" })).status).toBe(204);
    const mail = t.mails.at(-1);
    expect(mail?.to).toBe("qa@acme.vn");
    const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1];
    expect(code).toBeDefined();
    expect((await v.call("/api/access", { email: "qa@acme.vn", otp: "000000" })).status).toBe(401);
    expect((await v.call("/api/access", { email: "qa@acme.vn", otp: code })).status).toBe(204);
    expect((await v.call("/api/meta")).status).toBe(200);
    const [vis] = await t.db.query<{ email: string; verified: boolean }>(
      "SELECT email, verified_at IS NOT NULL AS verified FROM visitors WHERE link_slug = $1 AND email IS NOT NULL",
      [l.slug],
    );
    expect(vis).toEqual({ email: "qa@acme.vn", verified: true });
  });

  it("allowlist: only listed emails or domains get a code", async () => {
    const l = await link({ access_mode: "allowlist", allowlist: ["pm@partner.com", "*@acme.vn"] });
    const v = visitor(t, l.slug);
    expect((await v.call("/api/access", { email: "someone@other.com" })).status).toBe(401);
    expect(t.mails).toHaveLength(0);
    expect((await v.call("/api/access", { email: "lan@acme.vn" })).status).toBe(204);
    expect((await v.call("/api/access", { email: "pm@partner.com" })).status).toBe(204);
    expect(t.mails.map((m) => m.to)).toEqual(["lan@acme.vn", "pm@partner.com"]);
  });

  it("email modes need a configured mail server", async () => {
    t.deps.mailer.available = false;
    await expect(link({ access_mode: "email_otp" })).rejects.toMatchObject({ status: 422 });
  });

  it("enforces the per-link hourly question limit", async () => {
    const l = await link({ access_mode: "open", rate_limit_per_hour: 2 });
    const v = visitor(t, l.slug);
    for (let i = 0; i < 2; i++) {
      expect((await v.call("/api/ask", { question: "Do refunds include shipping?" })).status).toBe(
        200,
      );
    }
    expect((await v.call("/api/ask", { question: "Do refunds include shipping?" })).status).toBe(
      429,
    );
  });
});
