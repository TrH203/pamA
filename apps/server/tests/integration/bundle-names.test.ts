import { afterEach, beforeEach, expect, it } from "vitest";
import {
  classifyReply,
  DIGEST_REPLY,
  makeCtx,
  routeFake,
  type TestCtx,
  transcriptInput,
} from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

describeEachDb("bundle names", (f) => {
  let t: TestCtx;
  let goal = DIGEST_REPLY.goal;
  beforeEach(async () => {
    goal = DIGEST_REPLY.goal;
    t = await makeCtx(f);
    routeFake(t.fake, { digest: () => ({ ...DIGEST_REPLY, goal }), classify: classifyReply });
  });
  afterEach(() => t.close());

  async function draft(over: Record<string, unknown> = {}) {
    const res = await t.req("/v1/transcripts/digest", { json: transcriptInput(over) });
    return (await res.json()) as { digest_id: string; session_id: string; bundle_id: string };
  }
  const approve = (id: string) => t.req(`/v1/digests/${id}/approve`, { json: {} });
  const bundle = async (id: string) =>
    (
      await t.db.query<{ name: string; key: string | null; name_source: string; n: Date | null }>(
        "SELECT name, key, name_source, name_updated_at AS n FROM bundles WHERE id = $1",
        [id],
      )
    )[0];

  it("falls back to the key until a digest is approved", async () => {
    const d = await draft();
    expect(await bundle(d.bundle_id)).toMatchObject({
      name: "feat/refund-shipping",
      name_source: "key",
    });
  });

  it("suggests a name from the first approved digest only", async () => {
    const a = await draft({ agent_session_id: "s1" });
    await approve(a.digest_id);
    const first = await bundle(a.bundle_id);
    expect(first).toMatchObject({
      name: "Decide whether refunds include the shipping fee",
      name_source: "suggested",
    });
    expect(first?.n).not.toBeNull();

    goal = "Something else entirely about invoices.";
    const b = await draft({ agent_session_id: "s2" });
    await approve(b.digest_id);
    expect((await bundle(a.bundle_id))?.name).toBe(
      "Decide whether refunds include the shipping fee",
    );
  });

  it("owner names are never overwritten", async () => {
    const a = await draft({ agent_session_id: "s1" });
    await t.req(`/v1/bundles/${a.bundle_id}`, { method: "PATCH", json: { name: "Refund policy" } });
    expect(await bundle(a.bundle_id)).toMatchObject({
      name: "Refund policy",
      name_source: "owner",
    });
    await approve(a.digest_id);
    expect(await bundle(a.bundle_id)).toMatchObject({
      name: "Refund policy",
      name_source: "owner",
    });
  });

  it("edited approval also suggests a name", async () => {
    const a = await draft({ agent_session_id: "s1" });
    const [row] = await t.db.query<{ content: Record<string, unknown> }>(
      "SELECT content FROM digests WHERE id = $1",
      [a.digest_id],
    );
    await t.req(`/v1/digests/${a.digest_id}/approve`, {
      json: { content: { ...row?.content, goal: "Clarify shipping refunds." } },
    });
    expect(await bundle(a.bundle_id)).toMatchObject({
      name: "Clarify shipping refunds",
      name_source: "suggested",
    });
  });

  it("merge and split names count as owner names", async () => {
    const a = await draft({ agent_session_id: "s1" });
    const b = await draft({
      agent_session_id: "s2",
      bundle_key: "fix/x",
      git: { branch: "fix/x" },
    });
    const merged = (await (
      await t.req("/v1/bundles/merge", {
        json: { bundle_ids: [a.bundle_id, b.bundle_id], name: "All" },
      })
    ).json()) as { id: string };
    expect(await bundle(merged.id)).toMatchObject({ name: "All", name_source: "owner" });
    const split = (await (
      await t.req(`/v1/bundles/${merged.id}/split`, {
        json: { session_ids: [b.session_id], new_name: "Second" },
      })
    ).json()) as { id: string };
    expect(await bundle(split.id)).toMatchObject({ name: "Second", name_source: "owner" });
  });
});
