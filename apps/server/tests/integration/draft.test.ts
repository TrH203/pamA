// Hotkey drafts (US3): answer from the owner's own approved items, cite or refuse, never send.
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Seeded, seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

interface Draft {
  ask_id: string;
  status: "answered" | "refused";
  answer?: string;
  reason?: string;
  citations: { item_id: string; label: string }[];
  confidence: number;
  suggested_scope: { type: string; id: string; title: string }[];
}

describeEachDb("POST /v1/draft", (f) => {
  let t: TestCtx;
  let s: Seeded;
  beforeEach(async () => {
    t = await makeCtx(f);
    s = await seed(t.deps);
  });
  afterEach(() => t.close());

  const draft = async (json: Record<string, unknown>) => {
    const res = await t.req("/v1/draft", { json });
    expect(res.status).toBe(200);
    return (await res.json()) as Draft;
  };

  it("drafts a cited answer from all of the owner's approved work", async () => {
    const d = await draft({ question: "Do refunds include the shipping fee?" });
    expect(d.status).toBe("answered");
    expect(d.citations.length).toBeGreaterThan(0);
    expect(d.suggested_scope[0]).toMatchObject({ type: "bundle", id: s.bundleRefund });
  });

  it("respects a scope hint", async () => {
    const d = await draft({
      question: "Do refunds include the shipping fee?",
      scope_hint: [{ type: "bundle", id: s.bundleCheckout }],
    });
    expect(d.status).toBe("refused");
    expect(d.reason).toBe("out_of_scope");
  });

  it("can shorten", async () => {
    const d = await draft({ question: "Do refunds include the shipping fee?", shorter: true });
    expect(d.status).toBe("answered");
    const last = t.fake.calls.filter((c) => c.system.includes("# pamA answer")).at(-1);
    expect(last?.system).toContain('Detail level "headline"');
  });

  it("records a drafted ask without a visitor", async () => {
    const d = await draft({ question: "How was the flaky checkout test fixed?" });
    const [row] = await t.db.query<{ origin: string; status: string; visitor_id: string | null }>(
      "SELECT origin, status, visitor_id FROM asks WHERE id = $1",
      [d.ask_id],
    );
    expect(row).toEqual({ origin: "hotkey", status: "drafted", visitor_id: null });
  });

  it("rejects bad input", async () => {
    expect((await t.req("/v1/draft", { json: { question: "" } })).status).toBe(422);
  });
});
