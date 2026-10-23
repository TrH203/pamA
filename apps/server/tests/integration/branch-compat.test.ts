// Old data and old clients keep working (spec 002 FR-015/016, US4).
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const fixtures = join(import.meta.dirname, "../../../../packages/types/fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

describeEachDb("branch compatibility", (f) => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(f, { mode: "selfhost" });
    routeFake(t.fake, { digest: () => DIGEST_REPLY, classify: classifyReply });
  });
  afterEach(() => t.close());

  async function receive(doc: unknown, id: string) {
    const code = (await (await t.req("/v1/devices/pairing-code", { json: {} })).json()) as {
      code: string;
    };
    const paired = (await (
      await t.app.request("/v1/devices/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.code, device_name: `d-${id}` }),
      })
    ).json()) as { token: string };
    return t.app.request("/v1/sync/digests", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${paired.token}` },
      body: JSON.stringify({
        outbox_id: id,
        digest: doc,
        approved_at: "2026-10-20T10:00:00Z",
        sync_enabled_at: new Date().toISOString(),
      }),
    });
  }
  const bundlesOf = async (ctx: TestCtx) =>
    ((await (await ctx.req("/v1/bundles")).json()) as { items: { branches: string[] }[] }).items;
  const bundles = () => bundlesOf(t);

  /** The device-side routes (transcripts) exist only on a local-mode server. */
  async function withLocal(fn: (local: TestCtx) => Promise<void>) {
    const local = await makeCtx(f);
    routeFake(local.fake, { digest: () => DIGEST_REPLY, classify: classifyReply });
    try {
      await fn(local);
    } finally {
      await local.close();
    }
  }

  it("a pre-feature digest (single git.branch) syncs and shows one branch", async () => {
    const res = await receive(fixture("digest-valid-legacy-single-branch.json"), "ob-legacy");
    expect(res.status).toBe(200);
    expect((await bundles())[0]?.branches).toEqual(["feat/refund-shipping"]);
  });

  it("a digest with a branch list syncs and lists every branch", async () => {
    const res = await receive(fixture("digest-valid-branches.json"), "ob-new");
    expect(res.status).toBe(200);
    expect((await bundles())[0]?.branches).toEqual([
      "main",
      "feat/refund-shipping",
      "fix/refund-typo",
    ]);
  });

  it("a digest without any git info lists no branch and does not fail", async () => {
    const doc = fixture("digest-valid-minimal.json");
    const res = await receive(doc, "ob-min");
    expect(res.status).toBe(200);
    expect((await bundles())[0]?.branches).toEqual([]);
  });

  it("an old client's transcript (bundle_key + git.branch only) is accepted", () =>
    withLocal(async (local) => {
      const res = await local.req("/v1/transcripts/digest", { json: transcriptInput() });
      expect(res.status).toBe(200);
      expect((await bundlesOf(local))[0]?.branches).toEqual(["feat/refund-shipping"]);
    }));

  it("the 0007 backfill keeps names and derives one branch per existing session", () =>
    withLocal(async (t) => {
      const first = (await (
        await t.req("/v1/transcripts/digest", {
          json: transcriptInput({ agent_session_id: "old-1" }),
        })
      ).json()) as { session_id: string; bundle_id: string };
      const second = (await (
        await t.req("/v1/transcripts/digest", {
          json: transcriptInput({ agent_session_id: "old-2", bundle_key: "fix/x", git: undefined }),
        })
      ).json()) as { session_id: string; bundle_id: string };
      await t.req(`/v1/bundles/${second.bundle_id}`, { method: "PATCH", json: { name: "Custom" } });

      // Put the data back into its pre-0007 shape, then run the migration's backfill statements.
      await t.db.query("DELETE FROM session_branches");
      await t.db.query("UPDATE bundles SET name_source = 'key', name_updated_at = NULL");
      const sql = readFileSync(
        join(import.meta.dirname, "../../migrations/0007_bundle_names_branches.sql"),
        "utf8",
      );
      const backfill = sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(
          (s) => s.startsWith('UPDATE "bundles"') || s.startsWith('INSERT INTO "session_branches"'),
        );
      expect(backfill).toHaveLength(2);
      for (const stmt of backfill) await t.db.query(stmt.replace(/;$/, ""));

      const src = await t.db.query<{ id: string; name_source: string }>(
        "SELECT id, name_source FROM bundles ORDER BY id",
      );
      expect(src.find((b) => b.id === first.bundle_id)?.name_source).toBe("key");
      expect(src.find((b) => b.id === second.bundle_id)?.name_source).toBe("owner");
      const rows = await t.db.query<{ session_id: string; name: string }>(
        "SELECT session_id, name FROM session_branches",
      );
      expect(rows).toEqual([{ session_id: first.session_id, name: "feat/refund-shipping" }]);
    }));
});
