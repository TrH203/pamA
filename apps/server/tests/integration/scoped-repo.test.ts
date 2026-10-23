// Scope is enforced in the data layer (Constitution II): every read goes through the scoped
// repository, and on Postgres/PGlite an RLS policy blocks rows even for a query without filters.
import { afterEach, beforeEach, expect, it } from "vitest";
import { fakeEmbedding } from "../../src/llm/fake.ts";
import { scopedItems, withScope } from "../../src/policy/scoped-repo.ts";
import { withdrawDigest } from "../../src/services/digests.ts";
import { type Seeded, seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

describeEachDb("scoped repository", (f) => {
  let t: TestCtx;
  let s: Seeded;
  beforeEach(async () => {
    t = await makeCtx(f);
    s = await seed(t.deps);
  });
  afterEach(() => t.close());

  const scope = (names: string[], denyLabels: string[] = []) => ({
    workspaceId: t.deps.workspaceId,
    sessionIds: names.map((n) => s.sessions[n] as string),
    denyLabels,
  });

  it("returns only items of the allowed sessions", async () => {
    const items = await scopedItems(t.db, scope(["refund-1", "refund-2"]), {
      embedding: fakeEmbedding("payment sandbox partner webhook"),
      text: "payment-sandbox partner",
      k: 50,
    });
    expect(items.length).toBeGreaterThan(0);
    const allowed = new Set([...(s.items["refund-1"] ?? []), ...(s.items["refund-2"] ?? [])]);
    expect(items.every((i) => allowed.has(i.id))).toBe(true);
    expect(JSON.stringify(items)).not.toMatch(/payment-sandbox|15% discount/);
  });

  it("drops items with denied labels", async () => {
    const items = await scopedItems(t.db, scope(["refund-2"], ["infra"]), {
      text: "worker cluster",
      k: 50,
    });
    expect(items.map((i) => i.text).join(" ")).not.toContain("refund-worker-01");
  });

  it("never returns items of withdrawn (inactive) digests", async () => {
    const [d] = await t.db.query<{ digest_id: string }>(
      "SELECT digest_id FROM digest_items WHERE session_id = $1 LIMIT 1",
      [s.sessions["refund-1"]],
    );
    await withdrawDigest(t.deps, d?.digest_id as string);
    const items = await scopedItems(t.db, scope(["refund-1"]), {
      text: "refund shipping fee",
      k: 50,
    });
    expect(items).toEqual([]);
  });

  it("returns nothing for an empty scope", async () => {
    expect(await scopedItems(t.db, scope([]), { text: "refund", k: 50 })).toEqual([]);
  });

  it("RLS blocks rows even for a raw query without any filter", async () => {
    const rows = await withScope(t.db, scope(["checkout-1"], ["business_sensitive"]), (q) =>
      q.query<{ id: string; text: string }>("SELECT id, text FROM digest_items"),
    );
    expect(rows.length).toBeGreaterThan(0);
    const allowed = new Set(s.items["checkout-1"]);
    expect(rows.every((r) => allowed.has(r.id))).toBe(true);
    expect(rows.map((r) => r.text).join(" ")).not.toContain("15% discount");
    // The scope does not leak out of the transaction.
    const all = await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM digest_items");
    expect(all[0]?.n).toBeGreaterThan(rows.length);
  });
});
