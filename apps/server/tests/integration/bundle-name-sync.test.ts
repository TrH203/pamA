import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Seeded, seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb, pglite } from "../helpers/db.ts";

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
  decisions: [{ id: 1, what: "Refunds exclude shipping.", why: "Carrier fee is non-refundable." }],
  outcome: "Refund service excludes shipping.",
  open_items: [],
  modules: ["refunds"],
  redactions: { secret: 0, pii: 0 },
};

describeEachDb("replica applies bundle names", (f) => {
  let t: TestCtx;
  let token: string;
  beforeEach(async () => {
    t = await makeCtx(f, { mode: "selfhost" });
    const code = (await (await t.req("/v1/devices/pairing-code", { json: {} })).json()) as {
      code: string;
    };
    const paired = await t.app.request("/v1/devices/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.code, device_name: "mbp" }),
    });
    ({ token } = (await paired.json()) as { token: string });
  });
  afterEach(() => t.close());

  let n = 0;
  const send = (over: Record<string, unknown>) =>
    t.app.request("/v1/sync/digests", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        outbox_id: `ob-${++n}`,
        digest: DIGEST,
        approved_at: "2026-10-20T10:00:00Z",
        sync_enabled_at: new Date().toISOString(),
        ...over,
      }),
    });
  const row = async () =>
    (
      await t.db.query<{ id: string; name: string; name_source: string }>(
        "SELECT id, name, name_source FROM bundles",
      )
    )[0];

  it("suggested names replace the key but never a replica owner name", async () => {
    expect(
      (await send({ bundle_name: "Refund shipping", bundle_name_source: "suggested" })).status,
    ).toBe(200);
    expect(await row()).toMatchObject({ name: "Refund shipping", name_source: "suggested" });
    await send({ bundle_name: "Newer suggestion", bundle_name_source: "suggested" });
    expect((await row())?.name).toBe("Newer suggestion");

    await t.req(`/v1/bundles/${(await row())?.id}`, { method: "PATCH", json: { name: "Mine" } });
    await send({ bundle_name: "Ignored suggestion", bundle_name_source: "suggested" });
    expect(await row()).toMatchObject({ name: "Mine", name_source: "owner" });
  });

  it("a device owner rename overwrites; legacy clients do not override owner names", async () => {
    await send({ bundle_name: "Refund shipping", bundle_name_source: "suggested" });
    await send({ bundle_name: "Device owner name", bundle_name_source: "owner" });
    expect(await row()).toMatchObject({ name: "Device owner name", name_source: "owner" });
    await send({ bundle_name: "Legacy rename" }); // no bundle_name_source
    expect((await row())?.name).toBe("Device owner name");
  });

  it("legacy clients still replace a key-named bundle", async () => {
    await send({ bundle_name: "feat/refund-shipping" });
    expect((await row())?.name_source).toBe("key");
    await send({ bundle_name: "Refunds" });
    expect((await row())?.name).toBe("Refunds");
  });

  it("re-delivery after a rename is idempotent for the digest", async () => {
    const first = (await (
      await send({ bundle_name: "A", bundle_name_source: "suggested" })
    ).json()) as {
      digest_id: string;
    };
    const again = (await (
      await send({ bundle_name: "B", bundle_name_source: "owner" })
    ).json()) as {
      digest_id: string;
    };
    expect(again.digest_id).toBe(first.digest_id);
    const [c] = await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM digests");
    expect(c?.n).toBe(1);
    expect((await row())?.name).toBe("B");
  });
});

describe("owner's machine: rename is re-delivered", () => {
  let t: TestCtx;
  let s: Seeded;
  beforeEach(async () => {
    t = await makeCtx(pglite);
    s = await seed(t.deps);
  });
  afterEach(() => t.close());

  type Pending = {
    digests: {
      digest_id: string;
      target: string;
      bundle_name: string;
      bundle_name_source: string;
    }[];
  };
  const pending = async () => (await (await t.req("/v1/sync/pending")).json()) as Pending;
  const handOff = async () => {
    const p = await pending();
    await t.req("/v1/sync/ack", {
      json: {
        digests: p.digests.map((d) => ({ digest_id: d.digest_id, target: d.target })),
        tombstones: [],
      },
    });
  };

  it("an owner rename on a synced bundle makes its latest approved digest deliverable again", async () => {
    await t.req(`/v1/projects/${s.projectA}`, {
      method: "PATCH",
      json: { sync_enabled: true, sync_target: "https://pama.acme.vn" },
    });
    await handOff();
    expect((await pending()).digests).toEqual([]);

    await t.req(`/v1/bundles/${s.bundleRefund}`, {
      method: "PATCH",
      json: { name: "Refund policy" },
    });
    const p = await pending();
    expect(p.digests).toHaveLength(1);
    expect(p.digests[0]).toMatchObject({
      bundle_name: "Refund policy",
      bundle_name_source: "owner",
    });
  });

  it("a rename on a bundle that is not synced queues nothing", async () => {
    await t.req(`/v1/bundles/${s.bundleRefund}`, {
      method: "PATCH",
      json: { name: "Refund policy" },
    });
    expect((await pending()).digests).toEqual([]);
  });
});
