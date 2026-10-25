// Thin client (spec 004): device login, device token as the owner of its workspace, drafts from
// devices, review pull-back, and isolation between workspaces on a cloud server.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyReply, makeCtx, routeFake, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb, pglite } from "../helpers/db.ts";

const json = (body: unknown, token?: string, cookie?: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { cookie } : {}),
  },
  body: JSON.stringify(body),
});
const get = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function signIn(
  t: TestCtx,
  email: string,
  next?: string,
): Promise<{ cookie: string; location: string }> {
  const res = await t.app.request("/v1/auth/login", json(next ? { email, next } : { email }));
  expect(res.status).toBe(204);
  const mail = t.mails.findLast((m) => m.to === email.toLowerCase());
  const url = new URL(
    /https?:\/\/\S+\/v1\/auth\/callback\?token=\S+/.exec(mail?.text ?? "")?.[0] as string,
  );
  const cb = await t.app.request(url.pathname + url.search);
  expect(cb.status).toBe(302);
  return {
    cookie: (cb.headers.get("set-cookie") ?? "").split(";")[0] as string,
    location: cb.headers.get("location") ?? "",
  };
}

interface Started {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

async function login(t: TestCtx, cookie: string, name = "hien-mbp") {
  const start = (await (
    await t.app.request("/v1/auth/device/start", json({ device_name: name }))
  ).json()) as Started;
  const ok = await t.app.request(
    "/v1/auth/device/approve",
    json({ user_code: start.user_code }, undefined, cookie),
  );
  expect(ok.status).toBe(200);
  const tok = await t.app.request(
    "/v1/auth/device/token",
    json({ device_code: start.device_code }),
  );
  expect(tok.status).toBe(200);
  return (await tok.json()) as { token: string; device_id: string; workspace_id: string };
}

const DIGEST = {
  schema_version: 1,
  source: {
    agent: "claude_code",
    agent_session_id: "thin-1",
    project_key: "github.com/acme/shop",
    bundle_key: "feat/refunds",
    ended_at: "2026-10-25T09:00:00Z",
  },
  goal: "Decide whether refunds include the shipping fee.",
  decisions: [{ id: 1, what: "Refunds exclude shipping.", why: "Carrier fee is non-refundable." }],
  outcome: "Refund service excludes shipping.",
  open_items: [],
  modules: ["refunds"],
  redactions: { secret: 0, pii: 0 },
};

describe("device login", () => {
  let t: TestCtx;
  let cookie: string;
  beforeEach(async () => {
    t = await makeCtx(pglite, { mode: "cloud" });
    ({ cookie } = await signIn(t, "hien@acme.vn"));
  });
  afterEach(() => t.close());

  it("start → pending → approve → token exactly once", async () => {
    const res = await t.app.request("/v1/auth/device/start", json({ device_name: "mbp" }));
    expect(res.status).toBe(200);
    const s = (await res.json()) as Started;
    expect(s.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(s.verification_uri_complete).toContain(`device=${s.user_code}`);
    expect(s.expires_in).toBe(600);

    const poll = () => t.app.request("/v1/auth/device/token", json({ device_code: s.device_code }));
    const pending = await poll();
    expect(pending.status).toBe(428);
    expect(((await pending.json()) as { error: { code: string } }).error.code).toBe(
      "authorization_pending",
    );

    const look = await t.app.request(`/v1/auth/device/lookup?code=${s.user_code.toLowerCase()}`, {
      headers: { cookie },
    });
    expect(((await look.json()) as { device_name: string }).device_name).toBe("mbp");
    // Approval needs a signed-in owner.
    expect(
      (await t.app.request("/v1/auth/device/approve", json({ user_code: s.user_code }))).status,
    ).toBe(401);
    expect(
      (
        await t.app.request(
          "/v1/auth/device/approve",
          json({ user_code: s.user_code }, undefined, cookie),
        )
      ).status,
    ).toBe(200);

    const done = await poll();
    expect(done.status).toBe(200);
    const body = (await done.json()) as { token: string; device_id: string };
    expect(body.token).toMatch(/^pd_/);
    expect((await poll()).status).toBe(410);

    const devices = (await (
      await t.app.request("/v1/devices", { headers: { cookie } })
    ).json()) as {
      items: { id: string; name: string }[];
    };
    expect(devices.items.map((d) => d.id)).toContain(body.device_id);
  });

  it("denied and expired requests never yield a token", async () => {
    const s = (await (
      await t.app.request("/v1/auth/device/start", json({ device_name: "x" }))
    ).json()) as Started;
    expect(
      (
        await t.app.request(
          "/v1/auth/device/deny",
          json({ user_code: s.user_code }, undefined, cookie),
        )
      ).status,
    ).toBe(204);
    expect(
      (await t.app.request("/v1/auth/device/token", json({ device_code: s.device_code }))).status,
    ).toBe(403);

    const e = (await (
      await t.app.request("/v1/auth/device/start", json({ device_name: "y" }))
    ).json()) as Started;
    await t.db.query("UPDATE device_auth_requests SET expires_at = now() - interval '1 minute'");
    expect(
      (
        await t.app.request(
          "/v1/auth/device/approve",
          json({ user_code: e.user_code }, undefined, cookie),
        )
      ).status,
    ).toBe(410);
    expect(
      (await t.app.request("/v1/auth/device/token", json({ device_code: e.device_code }))).status,
    ).toBe(410);
    expect(
      (await t.app.request("/v1/auth/device/token", json({ device_code: "nope" }))).status,
    ).toBe(410);
  });

  it("sign-in returns to the approval page", async () => {
    const r = await signIn(t, "hien@acme.vn", "/?device=ABCD-EFGH");
    expect(r.location).toBe("/?device=ABCD-EFGH");
    const bad = await signIn(t, "hien@acme.vn", "//evil.example/x");
    expect(bad.location).toBe("/");
  });

  it("a device opens the console through a one-time link", async () => {
    const d = await login(t, cookie);
    const res = await t.app.request("/v1/auth/device/console-link", json({}, d.token));
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    const cb = await t.app.request(url.pathname + url.search);
    expect(cb.status).toBe(302);
    expect((await t.app.request(url.pathname + url.search)).status).toBe(410);
  });
});

describe("device login in local mode", () => {
  it("is not offered", async () => {
    const t = await makeCtx(pglite);
    expect((await t.app.request("/v1/auth/device/start", json({ device_name: "x" }))).status).toBe(
      404,
    );
    await t.close();
  });
});

describeEachDb("device token as owner", (f) => {
  let t: TestCtx;
  let a: { token: string; device_id: string };
  let b: { token: string; device_id: string };
  beforeEach(async () => {
    t = await makeCtx(f, { mode: "cloud" });
    routeFake(t.fake, { classify: classifyReply });
    a = await login(t, (await signIn(t, "a@acme.vn")).cookie, "a-laptop");
    b = await login(t, (await signIn(t, "b@other.vn")).cookie, "b-laptop");
  });
  afterEach(() => t.close());

  const draft = (token: string, outbox_id: string, over: Record<string, unknown> = {}) =>
    t.app.request(
      "/v1/sync/drafts",
      json(
        {
          outbox_id,
          digest: DIGEST,
          sync_enabled_at: new Date().toISOString(),
          project_name: "shop",
          ...over,
        },
        token,
      ),
    );

  it("reaches owner routes in its own workspace and never the local-only ones", async () => {
    expect((await t.app.request("/v1/review", get(a.token))).status).toBe(200);
    expect((await t.app.request("/v1/links", get(a.token))).status).toBe(200);
    expect((await t.app.request("/v1/inbox", get(a.token))).status).toBe(200);
    expect((await t.app.request("/v1/sync/pending", get(a.token))).status).toBe(403);
    expect((await t.app.request("/v1/transcripts/digest", json({}, a.token))).status).toBe(403);
    expect(
      (await t.app.request("/v1/review", get("pd_AAAAAAAA_bbbbbbbbbbbbbbbbbbbbbbbbbbbb"))).status,
    ).toBe(401);
  });

  it("revoked devices are refused", async () => {
    expect(
      (await t.app.request(`/v1/devices/${a.device_id}/revoke`, json({}, a.token))).status,
    ).toBe(204);
    expect((await t.app.request("/v1/review", get(a.token))).status).toBe(401);
  });

  it("drafts land in review, idempotently, labelled with the device", async () => {
    const r1 = await draft(a.token, "ob-1");
    expect(r1.status).toBe(200);
    const d1 = (await r1.json()) as { digest_id: string; status: string };
    expect(d1.status).toBe("draft");
    const again = (await (await draft(a.token, "ob-1")).json()) as { digest_id: string };
    expect(again.digest_id).toBe(d1.digest_id);

    const review = (await (await t.app.request("/v1/review", get(a.token))).json()) as {
      items: { id: string; device: string | null }[];
    };
    expect(review.items).toHaveLength(1);
    expect(review.items[0]?.device).toBe("a-laptop");
  });

  it("workspaces never see each other", async () => {
    const d = (await (await draft(a.token, "ob-2")).json()) as { digest_id: string };
    const reviewB = (await (await t.app.request("/v1/review", get(b.token))).json()) as {
      items: unknown[];
    };
    expect(reviewB.items).toEqual([]);
    expect((await t.app.request(`/v1/digests/${d.digest_id}`, get(b.token))).status).toBe(404);
    expect(
      (await t.app.request(`/v1/digests/${d.digest_id}/approve`, json({}, b.token))).status,
    ).toBe(404);
    const changesB = (await (await t.app.request("/v1/sync/changes", get(b.token))).json()) as {
      changes: unknown[];
    };
    expect(changesB.changes).toEqual([]);
  });

  it("review decisions made on the server are listed for pull-back", async () => {
    const d = (await (await draft(a.token, "ob-3")).json()) as { digest_id: string };
    const first = (await (await t.app.request("/v1/sync/changes", get(a.token))).json()) as {
      changes: { status: string; agent_session_id: string }[];
      cursor: string;
    };
    expect(first.changes.map((c) => c.status)).toEqual(["draft"]);

    const edited = { ...DIGEST, goal: "Refunds exclude the shipping fee (edited)." };
    await t.app.request(`/v1/digests/${d.digest_id}/approve`, json({ content: edited }, a.token));
    const next = (await (
      await t.app.request(`/v1/sync/changes?since=${first.cursor}`, get(a.token))
    ).json()) as {
      changes: { status: string; agent_session_id: string; digest?: { goal: string } }[];
      cursor: string;
    };
    const approved = next.changes.find((c) => c.status === "approved");
    expect(approved?.agent_session_id).toBe("thin-1");
    expect(approved?.digest?.goal).toContain("edited");
    const none = (await (
      await t.app.request(`/v1/sync/changes?since=${next.cursor}`, get(a.token))
    ).json()) as { changes: unknown[] };
    expect(none.changes).toEqual([]);
  });

  it("a newer device tombstone refuses stale drafts", async () => {
    const enabledAt = new Date(Date.now() - 60_000).toISOString();
    await t.app.request(
      "/v1/sync/tombstones",
      json(
        { outbox_id: "t-1", source_type: "project", source_key: "github.com/acme/shop" },
        a.token,
      ),
    );
    expect((await draft(a.token, "ob-4", { sync_enabled_at: enabledAt })).status).toBe(409);
  });
});

describe("per-workspace answering model (cloud)", () => {
  let t: TestCtx;
  let a: string;
  let b: string;
  beforeEach(async () => {
    t = await makeCtx(pglite, { mode: "cloud" });
    a = (await signIn(t, "a@acme.vn")).cookie;
    b = (await signIn(t, "b@other.vn")).cookie;
  });
  afterEach(() => t.close());

  const put = (cookie: string, role: string, body: unknown) =>
    t.app.request(`/v1/models/settings/${role}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  const view = async (cookie: string) =>
    (await (await t.app.request("/v1/models/settings", { headers: { cookie } })).json()) as {
      roles: Record<string, { scope?: string; model: string; baseUrl?: string }>;
    };

  it("an owner brings their own chat model without affecting other workspaces", async () => {
    const own = {
      provider: "openai-compatible",
      model: "my-model",
      baseUrl: "https://llm.acme.invalid/v1",
      apiKey: "sk-test-key",
      confirm: ["unverified"],
    };
    expect((await put(a, "chat", own)).status).toBe(200);
    expect((await view(a)).roles.chat).toMatchObject({ scope: "workspace", model: "my-model" });
    expect((await view(b)).roles.chat?.scope).toBe("server");
    expect((await view(b)).roles.chat?.baseUrl).toBeUndefined();

    // Only the chat role, and never an endpoint inside the operator's network.
    expect((await put(a, "embed", own)).status).toBe(403);
    for (const baseUrl of [
      "http://llm.acme.invalid/v1",
      "https://127.0.0.1/v1",
      "https://10.0.0.5/v1",
    ]) {
      expect((await put(a, "chat", { ...own, baseUrl })).status).toBe(422);
    }
    expect((await put(a, "chat", { provider: "ollama", model: "x", confirm: [] })).status).toBe(
      422,
    );

    const back = await t.app.request("/v1/models/settings/chat/revert", json({}, undefined, a));
    expect(back.status).toBe(200);
    expect((await view(a)).roles.chat?.scope).toBe("server");
  });
});
