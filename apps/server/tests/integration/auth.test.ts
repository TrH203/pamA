// Owner sign-in on servers (US5): email magic link → session cookie. Self-host accepts only the
// configured owner email; cloud signs up one workspace per email, and workspaces never see each
// other's data.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { pglite } from "../helpers/db.ts";

async function signIn(t: TestCtx, email: string): Promise<string> {
  const res = await t.app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(204);
  const mail = t.mails.findLast((m) => m.to === email.toLowerCase());
  const url = /https?:\/\/\S+\/v1\/auth\/callback\?token=\S+/.exec(mail?.text ?? "")?.[0];
  expect(url).toBeDefined();
  const cb = await t.app.request(new URL(url as string).pathname + new URL(url as string).search);
  expect(cb.status).toBe(302);
  return (cb.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

const owner = (t: TestCtx, cookie: string, path: string, json?: unknown) =>
  t.app.request(path, {
    method: json === undefined ? "GET" : "POST",
    headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

describe("self-host sign-in", () => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(pglite, { mode: "selfhost", ownerEmail: "hien@acme.vn" });
  });
  afterEach(() => t.close());

  it("the owner signs in with a one-time email link", async () => {
    expect((await t.app.request("/v1/review")).status).toBe(401);
    const cookie = await signIn(t, "Hien@acme.vn");
    expect(cookie).toMatch(/^pama_s=/);
    expect((await owner(t, cookie, "/v1/review")).status).toBe(200);
    const me = (await (await owner(t, cookie, "/v1/auth/me")).json()) as { email: string };
    expect(me.email).toBe("hien@acme.vn");
  });

  it("links are single use and other emails get nothing", async () => {
    await t.app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "intruder@evil.com" }),
    });
    expect(t.mails.filter((m) => m.to === "intruder@evil.com")).toEqual([]);
    await signIn(t, "hien@acme.vn");
    const url = /https?:\/\/\S+/.exec(t.mails.at(-1)?.text ?? "")?.[0] as string;
    expect((await t.app.request(new URL(url).pathname + new URL(url).search)).status).toBe(410);
  });

  it("signing out ends the session", async () => {
    const cookie = await signIn(t, "hien@acme.vn");
    await owner(t, cookie, "/v1/auth/logout", {});
    expect((await owner(t, cookie, "/v1/review")).status).toBe(401);
  });
});

describe("cloud workspaces", () => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(pglite, { mode: "cloud" });
  });
  afterEach(() => t.close());

  it("each email gets its own workspace and cannot see others", async () => {
    const a = await signIn(t, "a@one.com");
    const b = await signIn(t, "b@two.com");
    // A pairs a device and syncs a digest; B sees nothing.
    const code = (await (await owner(t, a, "/v1/devices/pairing-code", {})).json()) as {
      code: string;
    };
    const paired = (await (
      await t.app.request("/v1/devices/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.code, device_name: "a-laptop" }),
      })
    ).json()) as { token: string };
    const sync = await t.app.request("/v1/sync/digests", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${paired.token}` },
      body: JSON.stringify({
        outbox_id: "c-1",
        approved_at: "2026-10-20T10:00:00Z",
        sync_enabled_at: new Date().toISOString(),
        digest: {
          schema_version: 1,
          source: {
            agent: "codex",
            agent_session_id: "c1",
            project_key: "github.com/one/app",
            bundle_key: "main",
            ended_at: "2026-10-20T09:00:00Z",
          },
          goal: "Ship the invoice export.",
          decisions: [{ id: 1, what: "Invoices export as CSV.", why: "Finance asked for CSV." }],
          outcome: "Done.",
          open_items: [],
          modules: ["invoices"],
          redactions: { secret: 0, pii: 0 },
        },
      }),
    });
    expect(sync.status).toBe(200);
    const ab = (await (await owner(t, a, "/v1/bundles")).json()) as { items: { id: string }[] };
    const bb = (await (await owner(t, b, "/v1/bundles")).json()) as { items: unknown[] };
    expect(ab.items).toHaveLength(1);
    expect(bb.items).toEqual([]);

    // A's Ask Link works publicly and answers from A's workspace.
    const link = (await (
      await owner(t, a, "/v1/links", {
        sources: [{ type: "bundle", id: ab.items[0]?.id }],
        access_mode: "open",
      })
    ).json()) as { slug: string };
    const ask = (await (
      await t.app.request(`/a/${link.slug}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "How do invoices export for finance?" }),
      })
    ).json()) as { status: string };
    expect(ask.status).toBe("answered");
    // B cannot use A's link from the owner API.
    expect((await owner(t, b, `/v1/links/${link.slug}`)).status).toBe(404);
  });
});
