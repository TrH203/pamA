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

const T = (m: number) => `2026-10-20T08:${String(m).padStart(2, "0")}:00Z`;

describeEachDb("session branches", (f) => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(f);
    routeFake(t.fake, { digest: () => DIGEST_REPLY, classify: classifyReply });
  });
  afterEach(() => t.close());

  async function submit(over: Record<string, unknown> = {}) {
    const res = await t.req("/v1/transcripts/digest", { json: transcriptInput(over) });
    expect(res.status).toBe(200);
    return (await res.json()) as { digest_id: string; session_id: string; bundle_id: string };
  }
  const branchesOf = (sessionId: string) =>
    t.db.query<{ name: string; position: number; event_count: number }>(
      "SELECT name, position, event_count FROM session_branches WHERE session_id = $1 ORDER BY position",
      [sessionId],
    );
  const multi = (extra: Record<string, unknown> = {}) => ({
    bundle_key: "feat/login",
    git: {
      branch: "feat/login",
      branches: [
        { name: "main", first_seen: T(0), last_seen: T(2), events: 2 },
        { name: "feat/login", first_seen: T(2), last_seen: T(40), events: 30 },
        { name: "fix/typo", first_seen: T(40), last_seen: T(45), events: 5 },
      ],
    },
    ...extra,
  });

  it("stores every branch in visit order and files under bundle_key", async () => {
    const s = await submit(multi());
    expect(await branchesOf(s.session_id)).toEqual([
      { name: "main", position: 0, event_count: 2 },
      { name: "feat/login", position: 1, event_count: 30 },
      { name: "fix/typo", position: 2, event_count: 5 },
    ]);
    const [b] = await t.db.query<{ key: string }>("SELECT key FROM bundles WHERE id = $1", [
      s.bundle_id,
    ]);
    expect(b?.key).toBe("feat/login");
  });

  it("re-capture replaces the rows without duplicating the session", async () => {
    const a = await submit(multi());
    const b = await submit(
      multi({
        git: {
          branch: "feat/login",
          branches: [{ name: "feat/login", first_seen: T(2), last_seen: T(40), events: 30 }],
        },
      }),
    );
    expect(b.session_id).toBe(a.session_id);
    expect((await branchesOf(a.session_id)).map((r) => r.name)).toEqual(["feat/login"]);
    const [n] = await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM sessions");
    expect(n?.n).toBe(1);
  });

  it("re-files an unpinned session when the filing branch changes (same events)", async () => {
    const a = await submit(multi());
    const b = await submit(
      multi({
        bundle_key: "fix/typo",
        git: { branch: "fix/typo", branches: [{ name: "fix/typo" }] },
      }),
    );
    expect(b.session_id).toBe(a.session_id);
    expect(b.bundle_id).not.toBe(a.bundle_id);
    const [s] = await t.db.query<{ bundle_id: string }>(
      "SELECT bundle_id FROM sessions WHERE id = $1",
      [a.session_id],
    );
    expect(s?.bundle_id).toBe(b.bundle_id);
    const items = await t.db.query<{ bundle_id: string }>(
      "SELECT DISTINCT bundle_id FROM digest_items WHERE session_id = $1",
      [a.session_id],
    );
    expect(items).toEqual([{ bundle_id: b.bundle_id }]);
  });

  it("keeps a pinned session where the owner put it", async () => {
    await submit(multi({ agent_session_id: "keep" }));
    const s2 = await submit(multi({ agent_session_id: "moved" }));
    const split = (await (
      await t.req(`/v1/bundles/${s2.bundle_id}/split`, {
        json: { session_ids: [s2.session_id], new_name: "Owner bundle" },
      })
    ).json()) as { id: string };
    const [pinned] = await t.db.query<{ bundle_pinned: boolean }>(
      "SELECT bundle_pinned FROM sessions WHERE id = $1",
      [s2.session_id],
    );
    expect(pinned?.bundle_pinned).toBe(true);
    const again = await submit(
      multi({
        agent_session_id: "moved",
        bundle_key: "fix/typo",
        git: { branch: "fix/typo", branches: [{ name: "fix/typo" }] },
      }),
    );
    expect(again.bundle_id).toBe(split.id);
  });

  it("merge pins the moved sessions", async () => {
    const a = await submit(multi({ agent_session_id: "a" }));
    const b = await submit(
      multi({ agent_session_id: "b", bundle_key: "fix/typo", git: { branch: "fix/typo" } }),
    );
    await t.req("/v1/bundles/merge", {
      json: { bundle_ids: [a.bundle_id, b.bundle_id], name: "All" },
    });
    const rows = await t.db.query<{ bundle_pinned: boolean }>(
      "SELECT bundle_pinned FROM sessions WHERE id = $1",
      [b.session_id],
    );
    expect(rows[0]?.bundle_pinned).toBe(true);
  });

  it("treats a digest with only git.branch as a one-entry list and none without git", async () => {
    const one = await submit({ agent_session_id: "legacy" });
    expect((await branchesOf(one.session_id)).map((r) => r.name)).toEqual(["feat/refund-shipping"]);
    const none = await submit({ agent_session_id: "nogit", git: undefined, bundle_key: undefined });
    expect(await branchesOf(none.session_id)).toEqual([]);
  });

  it("rejects more than 20 branches", async () => {
    const res = await t.req("/v1/transcripts/digest", {
      json: transcriptInput({
        git: { branches: Array.from({ length: 21 }, (_, i) => ({ name: `b${i}` })) },
      }),
    });
    expect(res.status).toBe(422);
  });
});
