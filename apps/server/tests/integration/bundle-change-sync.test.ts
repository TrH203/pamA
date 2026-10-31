// Task (bundle) changes reach publish targets (spec 007): the owner's machine queues the
// resulting state of a renamed, split or merged task; the receiving server applies it
// idempotently, moving only sessions it has; the affected-links check lists Ask Links that would
// lose sources before sync is turned off.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLink } from "../../src/services/links.ts";
import { type Seeded, seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb, pglite } from "../helpers/db.ts";

const digestFor = (sid: string, bundle: string) => ({
  schema_version: 1,
  source: {
    agent: "claude_code",
    agent_session_id: sid,
    project_key: "github.com/acme/shop",
    bundle_key: bundle,
    ended_at: "2026-10-20T09:00:00Z",
  },
  goal: `Work on ${sid}.`,
  decisions: [{ id: 1, what: `Decision of ${sid}.`, why: "Because." }],
  outcome: "Done.",
  open_items: [],
  modules: [],
  redactions: { secret: 0, pii: 0 },
});

describeEachDb("receiving server: task changes", (f) => {
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
      body: JSON.stringify({ code: code.code, device_name: "hien-mbp" }),
    });
    ({ token } = (await paired.json()) as { token: string });
    for (const [sid, bundle] of [
      ["s1", "feat/a"],
      ["s2", "feat/a"],
      ["s3", "feat/b"],
    ] as const) {
      const r = await send("digests", {
        outbox_id: `ob-${sid}`,
        digest: digestFor(sid, bundle),
        approved_at: "2026-10-20T10:00:00Z",
        sync_enabled_at: new Date().toISOString(),
      });
      expect(r.status).toBe(200);
    }
  });
  afterEach(() => t.close());

  const send = (path: string, json: unknown, tok = () => token) =>
    t.app.request(`/v1/sync/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok()}` },
      body: JSON.stringify(json),
    });
  const tasks = async () =>
    t.db.query<{ key: string; name: string; name_source: string; sids: string[] }>(
      `SELECT b.key, b.name, b.name_source,
              array_agg(s.agent_session_id ORDER BY s.agent_session_id) AS sids
       FROM bundles b JOIN sessions s ON s.bundle_id = b.id GROUP BY b.id ORDER BY b.key`,
    );
  const change = (outbox_id: string, over: Record<string, unknown>) => ({
    outbox_id,
    project_key: "github.com/acme/shop",
    name_source: "owner",
    ...over,
  });

  it("split: moves the named sessions to a new task, pinned", async () => {
    const r = await send(
      "bundles",
      change("ob-c1", {
        bundle_ref: "id:01LOCALSPLIT",
        name: "Refund follow-up",
        sessions: [
          { agent: "claude_code", agent_session_id: "s2" },
          { agent: "claude_code", agent_session_id: "unknown-here" },
        ],
      }),
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { moved: number }).moved).toBe(1);
    expect(await tasks()).toEqual([
      { key: "feat/a", name: "feat/a", name_source: "key", sids: ["s1"] },
      { key: "feat/b", name: "feat/b", name_source: "key", sids: ["s3"] },
      { key: "id:01LOCALSPLIT", name: "Refund follow-up", name_source: "owner", sids: ["s2"] },
    ]);
    // A later delivery of s2 (filed under feat/a by its branch) does not re-file it.
    await send("digests", {
      outbox_id: "ob-s2-again",
      digest: { ...digestFor("s2", "feat/a"), goal: "Updated." },
      approved_at: "2026-10-20T11:00:00Z",
      sync_enabled_at: new Date().toISOString(),
    });
    expect((await tasks()).find((x) => x.key === "id:01LOCALSPLIT")?.sids).toEqual(["s2"]);
  });

  it("merge and rename: sessions join the kept task, empty tasks go, replays are no-ops", async () => {
    const merge = change("ob-c2", {
      bundle_ref: "feat/a",
      name: "Refunds",
      sessions: ["s1", "s2", "s3"].map((x) => ({ agent: "claude_code", agent_session_id: x })),
    });
    expect((await send("bundles", merge)).status).toBe(200);
    expect(await tasks()).toEqual([
      { key: "feat/a", name: "Refunds", name_source: "owner", sids: ["s1", "s2", "s3"] },
    ]);
    const again = await send("bundles", merge);
    expect(((await again.json()) as { moved: number }).moved).toBe(1); // stored receipt
    const rename = await send(
      "bundles",
      change("ob-c3", { bundle_ref: "feat/a", name: "Refund policy", sessions: [] }),
    );
    expect(rename.status).toBe(200);
    expect((await tasks())[0]?.name).toBe("Refund policy");
  });

  it("a suggested name never replaces a name the replica owner chose", async () => {
    await t.db.query(
      "UPDATE bundles SET name = 'Mine', name_source = 'owner' WHERE key = 'feat/b'",
    );
    await send(
      "bundles",
      change("ob-c4", {
        bundle_ref: "feat/b",
        name: "Suggested",
        name_source: "suggested",
        sessions: [],
      }),
    );
    expect((await tasks()).find((x) => x.key === "feat/b")?.name).toBe("Mine");
  });

  it("ignores unknown projects and rejects bad bodies and tokens", async () => {
    const r = await send(
      "bundles",
      change("ob-c5", {
        project_key: "github.com/acme/other",
        bundle_ref: "x",
        name: "X",
        sessions: [],
      }),
    );
    expect(await r.json()).toEqual({ bundle_id: null, moved: 0 });
    expect((await send("bundles", { outbox_id: "ob-bad" })).status).toBe(422);
    expect(
      (
        await send(
          "bundles",
          change("ob-c6", { bundle_ref: "x", name: "X", sessions: [] }),
          () => "",
        )
      ).status,
    ).toBe(401);
  });

  it("lists the Ask Links that would lose sources before sync is turned off", async () => {
    const [a] = await t.db.query<{ id: string }>("SELECT id FROM bundles WHERE key = 'feat/a'");
    const [b] = await t.db.query<{ id: string }>("SELECT id FROM bundles WHERE key = 'feat/b'");
    const onlyA = await createLink(t.deps, {
      sources: [{ type: "bundle", id: a?.id as string }],
      access_mode: "open",
    });
    const both = await createLink(t.deps, {
      sources: [
        { type: "bundle", id: a?.id as string },
        { type: "bundle", id: b?.id as string },
      ],
      access_mode: "open",
    });
    const ask = (type: string, key: string) =>
      t.app.request(
        `/v1/sync/affected-links?source_type=${type}&source_key=${encodeURIComponent(key)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
    const r = await ask("bundle", "github.com/acme/shop#feat/a");
    expect(r.status).toBe(200);
    const { links } = (await r.json()) as { links: { slug: string; empty: boolean }[] };
    expect(links).toEqual([
      expect.objectContaining({ slug: onlyA.slug, empty: true }),
      expect.objectContaining({ slug: both.slug, empty: false }),
    ]);
    // Removing one of two sessions of feat/a leaves the task: no link loses it.
    const one = (await (await ask("session", "claude_code:s1")).json()) as { links: unknown[] };
    expect(one.links).toEqual([]);
    const all = (await (await ask("project", "github.com/acme/shop")).json()) as {
      links: { empty: boolean }[];
    };
    expect(all.links).toHaveLength(2);
    expect(all.links.every((l) => l.empty)).toBe(true);
    expect((await ask("nope", "x")).status).toBe(422);
  });
});

describe("owner's machine: task changes for publish targets", () => {
  let t: TestCtx;
  let s: Seeded;
  beforeEach(async () => {
    t = await makeCtx(pglite);
    s = await seed(t.deps);
  });
  afterEach(() => t.close());

  type Pending = {
    tombstones: { id: string }[];
    bundle_changes: {
      id: string;
      target: string;
      change: { bundle_ref: string; name: string; sessions: { agent_session_id: string }[] };
    }[];
  };
  const pending = async () => (await (await t.req("/v1/sync/pending")).json()) as Pending;

  it("queues nothing for tasks that are not published", async () => {
    await t.req(`/v1/bundles/${s.bundleRefund}`, { method: "PATCH", json: { name: "Refunds" } });
    expect((await pending()).bundle_changes).toEqual([]);
  });

  it("queues rename, split and merge as task states; pending changes coalesce", async () => {
    await t.req(`/v1/projects/${s.projectA}`, {
      method: "PATCH",
      json: { sync_enabled: true, sync_target: "https://pama.acme.vn" },
    });
    await t.req(`/v1/bundles/${s.bundleRefund}`, { method: "PATCH", json: { name: "Refunds" } });
    await t.req(`/v1/bundles/${s.bundleRefund}`, { method: "PATCH", json: { name: "Refunds v2" } });
    let p = await pending();
    expect(p.bundle_changes).toHaveLength(1);
    expect(p.bundle_changes[0]?.change).toMatchObject({
      bundle_ref: "feat/refund-shipping",
      name: "Refunds v2",
    });

    const split = (await (
      await t.req(`/v1/bundles/${s.bundleRefund}/split`, {
        json: { session_ids: [s.sessions["refund-2"]], new_name: "Refund worker" },
      })
    ).json()) as { id: string };
    p = await pending();
    const sc = p.bundle_changes.find((c) => c.change.name === "Refund worker");
    expect(sc?.change.bundle_ref).toBe(`id:${split.id}`);
    expect(sc?.change.sessions.map((x) => x.agent_session_id)).toEqual(["refund-2"]);

    await t.req("/v1/bundles/merge", {
      json: { bundle_ids: [s.bundleRefund, s.bundleCheckout], name: "Shop work" },
    });
    p = await pending();
    const mc = p.bundle_changes.find((c) => c.change.name === "Shop work");
    expect(mc?.change.sessions.map((x) => x.agent_session_id).sort()).toEqual([
      "checkout-1",
      "refund-1",
    ]);

    await t.req("/v1/sync/ack", {
      json: { digests: [], tombstones: [], bundle_changes: p.bundle_changes.map((c) => c.id) },
    });
    expect((await pending()).bundle_changes).toEqual([]);
  });

  it("tells the device where a source is published and under which key", async () => {
    await t.req(`/v1/projects/${s.projectA}`, {
      method: "PATCH",
      json: { sync_enabled: true, sync_target: "https://pama.acme.vn" },
    });
    const r = await t.req(`/v1/sync/source?type=bundle&id=${s.bundleRefund}`);
    expect(await r.json()).toEqual({
      target: "https://pama.acme.vn",
      source_type: "bundle",
      source_key: "github.com/acme/shop#feat/refund-shipping",
    });
    const p = await t.req(`/v1/sync/source?type=project&id=${s.projectA}`);
    expect(((await p.json()) as { source_key: string }).source_key).toBe("github.com/acme/shop");
    expect((await t.req("/v1/sync/source?type=bundle&id=nope")).status).toBe(404);
  });
});
