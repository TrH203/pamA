import { afterEach, beforeEach, expect, it } from "vitest";
import { listBundles } from "../../src/services/bundles.ts";
import {
  classifyReply,
  DIGEST_REPLY,
  makeCtx,
  routeFake,
  type TestCtx,
  transcriptInput,
} from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

const T = (h: number, m = 0) =>
  `2026-10-20T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

type Item = {
  id: string;
  name: string;
  name_source: string;
  branches: string[];
  session_count: number;
  last_activity: string | null;
  sessions: { id: string; agent_session_id: string; branches: string[]; bundle_pinned: boolean }[];
};

describeEachDb("bundle summaries", (f) => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(f);
    routeFake(t.fake, { digest: () => DIGEST_REPLY, classify: classifyReply });
  });
  afterEach(() => t.close());

  async function submit(over: Record<string, unknown>) {
    const res = await t.req("/v1/transcripts/digest", { json: transcriptInput(over) });
    return (await res.json()) as { session_id: string; bundle_id: string };
  }
  const list = async () => ((await (await t.req("/v1/bundles")).json()) as { items: Item[] }).items;

  async function seedTwo() {
    const s1 = await submit({
      agent_session_id: "s1",
      bundle_key: "feat/login",
      ended_at: T(9),
      git: {
        branch: "feat/login",
        branches: [
          { name: "main", first_seen: T(8), last_seen: T(8, 5), events: 2 },
          { name: "feat/login", first_seen: T(8, 5), last_seen: T(8, 50), events: 30 },
          { name: "fix/typo", first_seen: T(8, 50), last_seen: T(9), events: 5 },
        ],
      },
    });
    const s2 = await submit({
      agent_session_id: "s2",
      bundle_key: "feat/login",
      ended_at: T(11),
      git: {
        branch: "feat/login",
        branches: [
          { name: "feat/login", first_seen: T(10), last_seen: T(10, 30), events: 8 },
          { name: "feat/login-fix", first_seen: T(10, 30), last_seen: T(11), events: 3 },
        ],
      },
    });
    return { s1, s2 };
  }

  it("derives branches, session count and last activity", async () => {
    await seedTwo();
    const [b] = await list();
    expect(b).toMatchObject({
      name_source: "key",
      branches: ["main", "feat/login", "fix/typo", "feat/login-fix"],
      session_count: 2,
    });
    expect(new Date(b?.last_activity ?? "").toISOString()).toBe("2026-10-20T11:00:00.000Z");
    const s1 = b?.sessions.find((s) => s.agent_session_id === "s1");
    expect(s1).toMatchObject({
      branches: ["main", "feat/login", "fix/typo"],
      bundle_pinned: false,
    });
  });

  it("stays correct after split and merge", async () => {
    const { s2 } = await seedTwo();
    const [before] = await list();
    const split = (await (
      await t.req(`/v1/bundles/${before?.id}/split`, {
        json: { session_ids: [s2.session_id], new_name: "Login fix" },
      })
    ).json()) as { id: string };
    const items = await list();
    const orig = items.find((i) => i.id === before?.id);
    const moved = items.find((i) => i.id === split.id);
    expect(orig).toMatchObject({ branches: ["main", "feat/login", "fix/typo"], session_count: 1 });
    expect(moved).toMatchObject({
      branches: ["feat/login", "feat/login-fix"],
      session_count: 1,
      name: "Login fix",
    });
    expect(moved?.sessions[0]?.bundle_pinned).toBe(true);

    await t.req("/v1/bundles/merge", {
      json: { bundle_ids: [before?.id, split.id], name: "Login" },
    });
    const [merged] = await list();
    expect(merged).toMatchObject({
      name: "Login",
      name_source: "owner",
      branches: ["main", "feat/login", "fix/typo", "feat/login-fix"],
      session_count: 2,
    });
  });

  it("moves sessions into a task in one step and deletes a task the move empties", async () => {
    const a = await submit({ agent_session_id: "a1", bundle_key: "feat/a" });
    await submit({ agent_session_id: "a2", bundle_key: "feat/a" });
    const b = await submit({ agent_session_id: "b1", bundle_key: "feat/b" });
    const c = await submit({ agent_session_id: "c1", bundle_key: "feat/c" });
    const before = await list();
    const target = before.find((i) => i.id === c.bundle_id);

    // a1 leaves a task that keeps a2; b1 is the only session of its task.
    const res = await t.req(`/v1/bundles/${c.bundle_id}/sessions`, {
      json: { session_ids: [a.session_id, b.session_id] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: c.bundle_id, remaining: [a.bundle_id] });

    const ids = await t.db.query<{ id: string }>("SELECT id FROM bundles ORDER BY id");
    expect(ids.map((r) => r.id).sort()).toEqual([a.bundle_id, c.bundle_id].sort());
    const items = await list();
    const moved = items.find((i) => i.id === c.bundle_id);
    expect(moved).toMatchObject({ name: target?.name, name_source: "key", session_count: 3 });
    expect(moved?.sessions.find((s) => s.id === a.session_id)?.bundle_pinned).toBe(true);
    expect(items.find((i) => i.id === a.bundle_id)?.session_count).toBe(1);
  });

  it("rejects a move with an unknown session and changes nothing", async () => {
    const a = await submit({ agent_session_id: "a1", bundle_key: "feat/a" });
    const c = await submit({ agent_session_id: "c1", bundle_key: "feat/c" });
    const res = await t.req(`/v1/bundles/${c.bundle_id}/sessions`, {
      json: { session_ids: [a.session_id, "nope"] },
    });
    expect(res.status).toBe(404);
    const [s] = await t.db.query<{ bundle_id: string }>(
      "SELECT bundle_id FROM sessions WHERE id = $1",
      [a.session_id],
    );
    expect(s?.bundle_id).toBe(a.bundle_id);
  });

  it("hides empty bundles and handles sessions without branches", async () => {
    await submit({ agent_session_id: "plain", git: undefined, bundle_key: "default" });
    const [b] = await list();
    expect(b).toMatchObject({ branches: [], session_count: 1 });
  });

  it("uses a constant number of queries regardless of bundle count", async () => {
    const count = async () => {
      let n = 0;
      const orig = t.db.query.bind(t.db);
      t.db.query = ((...a: Parameters<typeof orig>) => {
        n++;
        return orig(...a);
      }) as typeof t.db.query;
      await listBundles(t.db, t.deps.workspaceId);
      t.db.query = orig;
      return n;
    };
    await submit({ agent_session_id: "a", bundle_key: "k1" });
    const one = await count();
    await submit({ agent_session_id: "b", bundle_key: "k2" });
    await submit({ agent_session_id: "c", bundle_key: "k3" });
    expect(await count()).toBe(one);
  });
});
