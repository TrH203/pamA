// Library API (spec 007): sessions, digest versions, owner search, and session deletion with a
// tombstone for published copies.
import { afterEach, beforeEach, expect, it } from "vitest";
import { approveDigest } from "../../src/services/digests.ts";
import { createLink } from "../../src/services/links.ts";
import { type Seeded, seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

type Page<T> = { items: T[]; total: number; next_offset: number | null };
type SessionRow = {
  id: string;
  agent_session_id: string;
  project: string;
  bundle: string;
  status: string | null;
  goal: string | null;
  branches: string[];
};

describeEachDb("library", (f) => {
  let t: TestCtx;
  let s: Seeded;
  beforeEach(async () => {
    t = await makeCtx(f);
    s = await seed(t.deps);
  });
  afterEach(() => t.close());

  const get = async <T>(path: string) => {
    const r = await t.req(path);
    expect(r.status, path).toBe(200);
    return (await r.json()) as T;
  };

  it("lists sessions with filters and pagination", async () => {
    const all = await get<Page<SessionRow>>("/v1/sessions");
    expect(all.total).toBe(4);
    expect(all.items.every((x) => x.status === "approved")).toBe(true);
    const refund2 = all.items.find((x) => x.agent_session_id === "refund-2");
    expect(refund2?.branches).toEqual(["feat/refund-shipping", "fix/refund-typo"]);
    expect(refund2?.goal).toContain("background worker");

    const a = await get<Page<SessionRow>>(`/v1/sessions?project=${s.projectA}`);
    expect(a.total).toBe(3);
    const refund = await get<Page<SessionRow>>(`/v1/sessions?bundle=${s.bundleRefund}`);
    expect(refund.items.map((x) => x.agent_session_id).sort()).toEqual(["refund-1", "refund-2"]);
    expect((await get<Page<SessionRow>>("/v1/sessions?agent=codex")).total).toBe(0);
    expect((await get<Page<SessionRow>>("/v1/sessions?status=draft")).total).toBe(0);

    const p1 = await get<Page<SessionRow>>("/v1/sessions?limit=3");
    expect(p1.items).toHaveLength(3);
    expect(p1.next_offset).toBe(3);
    const p2 = await get<Page<SessionRow>>("/v1/sessions?limit=3&offset=3");
    expect(p2.items).toHaveLength(1);
    expect(p2.next_offset).toBeNull();
    expect((await t.req("/v1/sessions?status=bogus")).status).toBe(422);
  });

  it("shows one session with branches, digest versions and links that use it", async () => {
    const link = await createLink(t.deps, {
      sources: [{ type: "bundle", id: s.bundleRefund }],
      access_mode: "open",
    });
    const d = await get<{
      agent: string;
      project_key: string;
      bundle: string;
      branches: { name: string }[];
      digests: { version: number; status: string; goal: string }[];
      links: { slug: string }[];
      capture: null;
    }>(`/v1/sessions/${s.sessions["refund-2"]}`);
    expect(d.agent).toBe("claude_code");
    expect(d.project_key).toBe("github.com/acme/shop");
    expect(d.branches.map((b) => b.name)).toEqual(["feat/refund-shipping", "fix/refund-typo"]);
    expect(d.digests).toHaveLength(1);
    expect(d.digests[0]?.status).toBe("approved");
    expect(d.links.map((l) => l.slug)).toEqual([link.slug]);
    expect(d.capture).toBeNull();
    expect((await t.req("/v1/sessions/nope")).status).toBe(404);
  });

  it("lists digests by status, project and task", async () => {
    type D = { id: string; status: string; project: string; bundle: string; goal: string };
    expect((await get<Page<D>>("/v1/digests?status=approved")).total).toBe(4);
    expect((await get<Page<D>>("/v1/digests?status=draft")).total).toBe(0);
    const [first] = (await get<Page<D>>(`/v1/digests?bundle=${s.bundleCheckout}`)).items;
    expect(first?.goal).toBe("Fix the flaky checkout test.");
    await t.req(`/v1/digests/${first?.id}/withdraw`, { json: {} });
    expect((await get<Page<D>>("/v1/digests?status=withdrawn")).items.map((x) => x.id)).toEqual([
      first?.id,
    ]);
    expect((await get<Page<D>>(`/v1/digests?project=${s.projectB}`)).total).toBe(1);
    expect((await t.req("/v1/digests?status=nope")).status).toBe(422);
  });

  it("searches items across the workspace with refs to digest, session and task", async () => {
    const r = await get<{
      mode: string;
      items: {
        text: string;
        digest_id: string;
        session_id: string;
        bundle: string;
        project: string;
      }[];
    }>(`/v1/search?q=${encodeURIComponent("shipping fee refund")}`);
    expect(r.items.length).toBeGreaterThan(0);
    const top = r.items[0];
    expect(top?.text.toLowerCase()).toContain("shipping");
    expect(top?.bundle).toBe("feat/refund-shipping");
    expect(top?.project).toBe("shop");
    expect(top?.session_id).toBe(s.sessions["refund-1"]);
    // Owner search covers every project, including B.
    const b = await get<{ items: { project: string }[] }>("/v1/search?q=sandbox");
    expect(b.items.some((x) => x.project === "payment-sandbox")).toBe(true);
    expect((await t.req("/v1/search?q=")).status).toBe(422);
  });

  it("deletes a session and its digests; a published one leaves a tombstone", async () => {
    await t.req(`/v1/projects/${s.projectA}`, {
      method: "PATCH",
      json: { sync_enabled: true, sync_target: "https://pama.acme.vn" },
    });
    const link = await createLink(t.deps, {
      sources: [{ type: "session", id: s.sessions["checkout-1"] as string }],
      access_mode: "open",
    });
    const r = await t.req(`/v1/sessions/${s.sessions["checkout-1"]}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    const out = (await r.json()) as {
      digests: number;
      tombstone: boolean;
      links: { slug: string; empty: boolean }[];
    };
    expect(out.digests).toBe(1);
    expect(out.tombstone).toBe(true);
    expect(out.links).toEqual([expect.objectContaining({ slug: link.slug, empty: true })]);
    expect((await t.req(`/v1/sessions/${s.sessions["checkout-1"]}`)).status).toBe(404);
    // The checkout task had only this session: it is gone too.
    const [b] = await t.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM bundles WHERE id = $1",
      [s.bundleCheckout],
    );
    expect(b?.n).toBe(0);
    const pending = (await (await t.req("/v1/sync/pending")).json()) as {
      tombstones: { source_type: string; source_key: string }[];
    };
    expect(pending.tombstones).toEqual([
      expect.objectContaining({ source_type: "session", source_key: "claude_code:checkout-1" }),
    ]);

    // Not published: no tombstone.
    const r2 = await t.req(`/v1/sessions/${s.sessions["sandbox-1"]}`, { method: "DELETE" });
    expect(((await r2.json()) as { tombstone: boolean }).tombstone).toBe(false);
  });

  it("drafts appear as draft sessions", async () => {
    // A new draft version for refund-1 makes its session status 'draft'.
    const [d] = await t.db.query<{ id: string; content: unknown }>(
      "SELECT id, content FROM digests WHERE session_id = $1",
      [s.sessions["refund-1"]],
    );
    await t.db.query(
      `INSERT INTO digests (id, workspace_id, session_id, version, digest_hash, content, status)
       VALUES ('dr1', $1, $2, 2, 'h2', $3, 'draft')`,
      [t.deps.workspaceId, s.sessions["refund-1"], JSON.stringify(d?.content)],
    );
    const drafts = await get<Page<SessionRow>>("/v1/sessions?status=draft");
    expect(drafts.items.map((x) => x.agent_session_id)).toEqual(["refund-1"]);
    await approveDigest(t.deps, "dr1");
    expect((await get<Page<SessionRow>>("/v1/sessions?status=draft")).total).toBe(0);
  });
});
