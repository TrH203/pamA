// Sync (US4, FR-024..026): the receiving server accepts approved digests from paired devices,
// idempotently; tombstones delete remote copies and take links down; stale deliveries are refused.
// The owner's machine lists what to send and records what was handed to the device outbox.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLink } from "../../src/services/links.ts";
import { type Seeded, seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb, pglite } from "../helpers/db.ts";
import { visitor } from "../helpers/public.ts";

const DIGEST = {
  schema_version: 1,
  source: {
    agent: "claude_code",
    agent_session_id: "s-remote-1",
    project_key: "github.com/acme/shop",
    bundle_key: "feat/refund-shipping",
    ended_at: "2026-10-20T09:00:00Z",
  },
  goal: "Decide whether refunds include the shipping fee.",
  decisions: [
    {
      id: 1,
      what: "Refunds do not include the shipping fee.",
      why: "The carrier fee is non-refundable.",
    },
  ],
  outcome: "Refund service excludes shipping.",
  open_items: [],
  modules: ["refunds"],
  redactions: { secret: 1, pii: 0 },
};

describeEachDb("receiving server", (f) => {
  let t: TestCtx;
  let token: string;
  let deviceId: string;
  beforeEach(async () => {
    t = await makeCtx(f, { mode: "selfhost" });
    const code = (await (await t.req("/v1/devices/pairing-code", { json: {} })).json()) as {
      code: string;
    };
    const paired = await t.app.request("/v1/devices/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.code, device_name: "hien-mbp" }),
    });
    expect(paired.status).toBe(200);
    ({ token, device_id: deviceId } = (await paired.json()) as {
      token: string;
      device_id: string;
    });
  });
  afterEach(() => t.close());

  const send = (path: string, json: unknown, tok = token) =>
    t.app.request(`/v1/sync/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify(json),
    });
  const digest = (outbox_id: string, over: Record<string, unknown> = {}) =>
    send("digests", {
      outbox_id,
      digest: DIGEST,
      approved_at: "2026-10-20T10:00:00Z",
      sync_enabled_at: new Date().toISOString(),
      bundle_name: "Refunds",
      ...over,
    });

  it("pairing codes are single use", async () => {
    const code = (await (await t.req("/v1/devices/pairing-code", { json: {} })).json()) as {
      code: string;
    };
    const pair = () =>
      t.app.request("/v1/devices/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.code, device_name: "x" }),
      });
    expect((await pair()).status).toBe(200);
    expect((await pair()).status).toBe(410);
  });

  it("accepts approved digests idempotently and serves them through links", async () => {
    const a = await digest("ob-1");
    expect(a.status).toBe(200);
    const first = (await a.json()) as { digest_id: string; version: number };
    expect(first.version).toBe(1);
    expect(await (await digest("ob-1")).json()).toEqual(first); // same outbox id
    expect(((await (await digest("ob-2")).json()) as { digest_id: string }).digest_id).toBe(
      first.digest_id,
    ); // same content
    const [row] = await t.db.query<{ status: string; n: number }>(
      "SELECT d.status, (SELECT count(*)::int FROM digest_items i WHERE i.digest_id = d.id AND i.active) AS n FROM digests d WHERE d.id = $1",
      [first.digest_id],
    );
    expect(row?.status).toBe("approved");
    expect(row?.n).toBeGreaterThan(0);
  });

  it("rejects unauthenticated, revoked and invalid deliveries", async () => {
    expect((await send("digests", {}, "pd_nope1234_notarealtokenvalue0000")).status).toBe(401);
    expect((await send("digests", {}, "")).status).toBe(401);
    expect((await send("digests", { outbox_id: "ob-bad", digest: { goal: "" } })).status).toBe(422);
    await t.req(`/v1/devices/${deviceId}/revoke`, { json: {} });
    expect((await digest("ob-3")).status).toBe(401);
  });

  it("a tombstone deletes the remote copies and takes links down; stale deliveries get 409", async () => {
    await digest("ob-1");
    const [b] = await t.db.query<{ id: string }>(
      "SELECT id FROM bundles WHERE key = 'feat/refund-shipping'",
    );
    const link = await createLink(t.deps, {
      sources: [{ type: "bundle", id: b?.id as string }],
      access_mode: "open",
    });
    expect((await visitor(t, link.slug).call("/api/meta")).status).toBe(200);

    const enabledBefore = new Date().toISOString();
    const res = await send("tombstones", {
      outbox_id: "ob-t1",
      source_type: "bundle",
      source_key: "github.com/acme/shop#feat/refund-shipping",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted_items: number }).deleted_items).toBeGreaterThan(0);
    const left = await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM digest_items");
    expect(left[0]?.n).toBe(0);
    expect((await visitor(t, link.slug).call("/api/meta")).status).toBe(410);

    // Sent before sync was turned off and back on: refused.
    expect((await digest("ob-late", { sync_enabled_at: "2026-01-01T00:00:00Z" })).status).toBe(409);
    // Enabled again after the tombstone: accepted.
    expect(
      (await digest("ob-new", { sync_enabled_at: new Date(Date.now() + 1000).toISOString() }))
        .status,
    ).toBe(200);
    expect(enabledBefore).toBeTruthy();
  });
});

describe("owner's machine: what to sync", () => {
  let t: TestCtx;
  let s: Seeded;
  beforeEach(async () => {
    t = await makeCtx(pglite);
    s = await seed(t.deps);
  });
  afterEach(() => t.close());

  const pending = async () =>
    (await (await t.req("/v1/sync/pending")).json()) as {
      digests: {
        digest_id: string;
        target: string;
        digest: { source: { project_key: string } };
        sync_enabled_at: string;
      }[];
      tombstones: { id: string; target: string; source_type: string; source_key: string }[];
    };

  it("is off by default", async () => {
    expect(await pending()).toEqual({ digests: [], tombstones: [] });
    const status = (await (await t.req("/v1/sync/status")).json()) as {
      projects: { sync_enabled: boolean }[];
    };
    expect(status.projects.every((p) => !p.sync_enabled)).toBe(true);
  });

  it("lists approved digests of enabled sources once they are handed off", async () => {
    await t.req(`/v1/projects/${s.projectA}`, {
      method: "PATCH",
      json: { sync_enabled: true, sync_target: "https://pama.acme.vn" },
    });
    const p = await pending();
    expect(p.digests).toHaveLength(3); // refund-1, refund-2, checkout-1 (not project B)
    expect(
      p.digests.every(
        (d) =>
          d.target === "https://pama.acme.vn" &&
          d.digest.source.project_key === "github.com/acme/shop",
      ),
    ).toBe(true);
    await t.req("/v1/sync/ack", {
      json: {
        digests: p.digests.map((d) => ({ digest_id: d.digest_id, target: d.target })),
        tombstones: [],
      },
    });
    expect((await pending()).digests).toEqual([]);
  });

  it("a bundle can opt out of a synced project", async () => {
    await t.req(`/v1/projects/${s.projectA}`, {
      method: "PATCH",
      json: { sync_enabled: true, sync_target: "https://pama.acme.vn" },
    });
    await t.req(`/v1/bundles/${s.bundleCheckout}`, {
      method: "PATCH",
      json: { sync_enabled: false },
    });
    const p = await pending();
    expect(p.digests).toHaveLength(2);
    expect(p.tombstones).toEqual([
      expect.objectContaining({
        source_type: "bundle",
        source_key: "github.com/acme/shop#fix/flaky-checkout-test",
      }),
    ]);
  });

  it("disabling sync queues a tombstone and resets deliveries", async () => {
    await t.req(`/v1/projects/${s.projectA}`, {
      method: "PATCH",
      json: { sync_enabled: true, sync_target: "https://pama.acme.vn" },
    });
    const p = await pending();
    await t.req("/v1/sync/ack", {
      json: {
        digests: p.digests.map((d) => ({ digest_id: d.digest_id, target: d.target })),
        tombstones: [],
      },
    });
    await t.req(`/v1/projects/${s.projectA}`, { method: "PATCH", json: { sync_enabled: false } });
    const after = await pending();
    expect(after.digests).toEqual([]);
    expect(after.tombstones).toEqual([
      expect.objectContaining({
        source_type: "project",
        source_key: "github.com/acme/shop",
        target: "https://pama.acme.vn",
      }),
    ]);
    await t.req("/v1/sync/ack", {
      json: { digests: [], tombstones: after.tombstones.map((x) => x.id) },
    });
    expect((await pending()).tombstones).toEqual([]);
  });

  it("withdrawing a synced digest queues a session tombstone", async () => {
    await t.req(`/v1/projects/${s.projectA}`, {
      method: "PATCH",
      json: { sync_enabled: true, sync_target: "https://pama.acme.vn" },
    });
    const [d] = await t.db.query<{ id: string }>("SELECT id FROM digests WHERE session_id = $1", [
      s.sessions["refund-1"],
    ]);
    await t.req(`/v1/digests/${d?.id}/withdraw`, { json: {} });
    expect((await pending()).tombstones).toEqual([
      expect.objectContaining({ source_type: "session", source_key: "claude_code:refund-1" }),
    ]);
  });
});
