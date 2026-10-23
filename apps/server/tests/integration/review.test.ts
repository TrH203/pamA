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

describeEachDb("review and digest lifecycle", (f) => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(f);
    routeFake(t.fake, { digest: () => DIGEST_REPLY, classify: classifyReply });
  });
  afterEach(() => t.close());

  async function draft(over: Record<string, unknown> = {}) {
    const res = await t.req("/v1/transcripts/digest", { json: transcriptInput(over) });
    return (await res.json()) as { digest_id: string; status: string };
  }
  const active = async (digestId: string) =>
    (
      await t.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM digest_items WHERE digest_id = $1 AND active",
        [digestId],
      )
    )[0]?.n;
  const statusOf = async (id: string) =>
    (await t.db.query<{ status: string }>("SELECT status FROM digests WHERE id = $1", [id]))[0]
      ?.status;

  it("lists drafts and approves them", async () => {
    const d = await draft();
    const list = (await (await t.req("/v1/review")).json()) as {
      items: { id: string; status: string; content: { goal: string } }[];
    };
    expect(list.items.map((i) => i.id)).toEqual([d.digest_id]);
    expect(list.items[0]?.content.goal).toBe(DIGEST_REPLY.goal);
    expect(await active(d.digest_id)).toBe(0);

    const res = await t.req(`/v1/digests/${d.digest_id}/approve`, { json: {} });
    expect(res.status).toBe(200);
    expect(await statusOf(d.digest_id)).toBe("approved");
    expect(await active(d.digest_id)).toBeGreaterThan(0);
    expect(((await (await t.req("/v1/review")).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("approving edited content creates a new version and supersedes the old one", async () => {
    const d = await draft();
    const [row] = await t.db.query<{ content: Record<string, unknown> }>(
      "SELECT content FROM digests WHERE id = $1",
      [d.digest_id],
    );
    const edited = { ...row?.content, goal: "Clarify the refund policy for shipping fees." };
    const res = await t.req(`/v1/digests/${d.digest_id}/approve`, { json: { content: edited } });
    const body = (await res.json()) as { digest_id: string; version: number; status: string };
    expect(body).toMatchObject({ version: 2, status: "approved" });
    expect(body.digest_id).not.toBe(d.digest_id);
    expect(await statusOf(d.digest_id)).toBe("superseded");
    expect(await active(d.digest_id)).toBe(0);
    const goal = await t.db.query<{ text: string }>(
      "SELECT text FROM digest_items WHERE digest_id = $1 AND kind = 'goal' AND active",
      [body.digest_id],
    );
    expect(goal[0]?.text).toBe("Clarify the refund policy for shipping fees.");
  });

  it("rejects edited content that breaks the schema or sneaks a secret in", async () => {
    const d = await draft();
    const bad = await t.req(`/v1/digests/${d.digest_id}/approve`, {
      json: { content: { goal: "" } },
    });
    expect(bad.status).toBe(422);
    const [row] = await t.db.query<{ content: Record<string, unknown> }>(
      "SELECT content FROM digests WHERE id = $1",
      [d.digest_id],
    );
    const res = await t.req(`/v1/digests/${d.digest_id}/approve`, {
      json: {
        content: { ...row?.content, outcome: "Token ghp_0123456789abcdefghijABCDEFGHIJ012345" },
      },
    });
    const ok = (await res.json()) as { digest_id: string };
    const [v2] = await t.db.query<{ content: { outcome: string } }>(
      "SELECT content FROM digests WHERE id = $1",
      [ok.digest_id],
    );
    expect(v2?.content.outcome).not.toContain("ghp_0123");
  });

  it("discards drafts and withdraws approved digests", async () => {
    const a = await draft();
    expect((await t.req(`/v1/digests/${a.digest_id}/discard`, { json: {} })).status).toBe(200);
    expect(await statusOf(a.digest_id)).toBe("discarded");
    expect((await t.req(`/v1/digests/${a.digest_id}/approve`, { json: {} })).status).toBe(409);

    const b = await draft({ agent_session_id: "sess-2" });
    await t.req(`/v1/digests/${b.digest_id}/approve`, { json: {} });
    expect(await active(b.digest_id)).toBeGreaterThan(0);
    expect((await t.req(`/v1/digests/${b.digest_id}/withdraw`, { json: {} })).status).toBe(200);
    expect(await statusOf(b.digest_id)).toBe("withdrawn");
    expect(await active(b.digest_id)).toBe(0);
  });

  it("auto-approves per project, overriding the workspace", async () => {
    const first = await draft();
    const [p] = await t.db.query<{ project_id: string }>(
      "SELECT s.project_id FROM digests d JOIN sessions s ON s.id = d.session_id WHERE d.id = $1",
      [first.digest_id],
    );
    const patch = await t.req(`/v1/projects/${p?.project_id}`, {
      method: "PATCH",
      json: { auto_approve: true },
    });
    expect(patch.status).toBe(200);
    const auto = await draft({ agent_session_id: "sess-auto" });
    expect(auto.status).toBe("approved");
    expect(await active(auto.digest_id)).toBeGreaterThan(0);

    const other = await draft({ agent_session_id: "sess-o", project_key: "github.com/acme/other" });
    expect(other.status).toBe("draft");
  });

  it("renames, splits and merges bundles", async () => {
    const a = await draft({ agent_session_id: "s-a" });
    await draft({ agent_session_id: "s-b" });
    const bundles = (await (await t.req("/v1/bundles")).json()) as {
      items: { id: string; name: string; sessions: { id: string; agent_session_id: string }[] }[];
    };
    expect(bundles.items).toHaveLength(1);
    const b = bundles.items[0];
    expect(b?.sessions).toHaveLength(2);

    await t.req(`/v1/bundles/${b?.id}`, { method: "PATCH", json: { name: "Refund policy" } });
    const sb = b?.sessions.find((s) => s.agent_session_id === "s-b");
    const split = (await (
      await t.req(`/v1/bundles/${b?.id}/split`, {
        json: { session_ids: [sb?.id], new_name: "Follow-up" },
      })
    ).json()) as { id: string };
    const after = (await (await t.req("/v1/bundles")).json()) as {
      items: { id: string; name: string; sessions: unknown[] }[];
    };
    expect(after.items.map((x) => [x.name, x.sessions.length]).sort()).toEqual([
      ["Follow-up", 1],
      ["Refund policy", 1],
    ]);
    // Items follow their session to the new bundle.
    const moved = await t.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM digest_items WHERE bundle_id = $1",
      [split.id],
    );
    expect(moved[0]?.n).toBeGreaterThan(0);

    const merged = (await (
      await t.req("/v1/bundles/merge", { json: { bundle_ids: [b?.id, split.id], name: "Refunds" } })
    ).json()) as { id: string };
    const final = (await (await t.req("/v1/bundles")).json()) as {
      items: { id: string; name: string; sessions: unknown[] }[];
    };
    expect(final.items).toEqual([expect.objectContaining({ id: merged.id, name: "Refunds" })]);
    expect(final.items[0]?.sessions).toHaveLength(2);
    expect(a.digest_id).toBeTruthy();
  });
});
