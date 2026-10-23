import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionDigestSchema } from "../../src/schema/digest.ts";
import {
  classifyReply,
  DIGEST_REPLY,
  makeCtx,
  routeFake,
  type TestCtx,
  transcriptInput,
} from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

describeEachDb("digest pipeline", (f) => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(f);
    routeFake(t.fake, { digest: () => DIGEST_REPLY, classify: classifyReply });
  });
  afterEach(() => t.close());

  async function submit(over: Record<string, unknown> = {}) {
    const res = await t.req("/v1/transcripts/digest", { json: transcriptInput(over) });
    expect(res.status).toBe(200);
    return (await res.json()) as { digest_id: string; version: number; status: string };
  }

  it("produces a schema-valid English draft with merged redaction counts", async () => {
    const out = await submit();
    expect(out).toMatchObject({ version: 1, status: "draft" });
    const [row] = await t.db.query<{ content: unknown; prompt_version: string }>(
      "SELECT content, prompt_version FROM digests WHERE id = $1",
      [out.digest_id],
    );
    const d = SessionDigestSchema.parse(row?.content);
    expect(row?.prompt_version).toBe("digest@1");
    expect(d.source).toMatchObject({
      agent: "claude_code",
      agent_session_id: "sess-1",
      project_key: "github.com/acme/shop",
      bundle_key: "feat/refund-shipping",
    });
    expect(d.decisions[0]).toMatchObject({
      id: 1,
      what: "Refunds do not include the shipping fee.",
    });
    expect(d.redactions.by_rule?.["cat-secret-file"]).toBe(1);
  });

  it("re-scans model output: secrets and PII never reach storage", async () => {
    const out = await submit();
    const [row] = await t.db.query<{ content: unknown }>(
      "SELECT content FROM digests WHERE id = $1",
      [out.digest_id],
    );
    const json = JSON.stringify(row?.content);
    expect(json).not.toContain("AKIAZ7Q4PL2XWN3VB5KD");
    expect(json).not.toContain("lan.tran@acme-corp.vn");
    expect(json).toContain("[SECRET:aws-access-token]");
    expect(json).toContain("[PII:email]");
    const d = SessionDigestSchema.parse(row?.content);
    expect(d.redactions.secret).toBeGreaterThanOrEqual(2);
    expect(d.redactions.pii).toBeGreaterThanOrEqual(1);
    const items = await t.db.query<{ text: string; rationale: string | null }>(
      "SELECT text, rationale FROM digest_items WHERE digest_id = $1",
      [out.digest_id],
    );
    expect(JSON.stringify(items)).not.toMatch(/AKIAZ7|lan\.tran/);
  });

  it("labels items and keeps draft items inactive", async () => {
    const out = await submit();
    const items = await t.db.query<{ id: string; kind: string; labels: string[]; active: boolean }>(
      "SELECT id, kind, labels, active FROM digest_items WHERE digest_id = $1 ORDER BY id",
      [out.digest_id],
    );
    expect(items.map((i) => i.kind).sort()).toEqual(
      ["decision", "decision", "goal", "module", "open_item", "outcome"].sort(),
    );
    expect(items.every((i) => !i.active)).toBe(true);
    const d2 = items.find((i) => i.id === `${out.digest_id}#d2`);
    expect(d2?.labels).toEqual(["infra"]);
    const withEmbedding = await t.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM digest_items WHERE digest_id = $1 AND embedding IS NOT NULL",
      [out.digest_id],
    );
    expect(withEmbedding[0]?.n).toBe(items.length);
  });

  it("groups sessions by branch and is idempotent", async () => {
    const a = await submit();
    const again = await submit();
    expect(again.digest_id).toBe(a.digest_id);
    await submit({ agent_session_id: "sess-2" });
    await submit({ agent_session_id: "sess-3", bundle_key: "fix/flaky-test" });
    const rows = await t.db.query<{ agent_session_id: string; bundle: string }>(
      `SELECT s.agent_session_id, b.key AS bundle FROM sessions s JOIN bundles b ON b.id = s.bundle_id
       ORDER BY s.agent_session_id`,
    );
    expect(rows).toEqual([
      { agent_session_id: "sess-1", bundle: "feat/refund-shipping" },
      { agent_session_id: "sess-2", bundle: "feat/refund-shipping" },
      { agent_session_id: "sess-3", bundle: "fix/flaky-test" },
    ]);
  });

  it("rejects transcripts that look like raw, unredacted paths or bad input", async () => {
    const res = await t.req("/v1/transcripts/digest", {
      json: transcriptInput({ project_key: "", events: "nope" }),
    });
    expect(res.status).toBe(422);
  });
});
