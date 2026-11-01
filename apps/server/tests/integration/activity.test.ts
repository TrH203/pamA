// Spec 006: every digest request is recorded as a run with stages and a coded error; a run that
// failed after drafting resumes from embed; activity routes and the SSE stream.
import type { EmbeddingModel } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { afterEach, beforeEach, expect, it } from "vitest";
import { tagModel } from "../../src/llm/errors.ts";
import { completeDigest, type ResumeState } from "../../src/pipeline/complete.ts";
import { events } from "../../src/routes/activity.ts";
import {
  classifyReply,
  DIGEST_REPLY,
  makeCtx,
  routeFake,
  type TestCtx,
  transcriptInput,
} from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

interface Run {
  id: string;
  kind: string;
  stage: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  role: string | null;
  provider: string | null;
  model: string | null;
  digest_id: string | null;
  attempts: number;
  resumable: boolean;
  duration_ms: number | null;
}

const unreachableEmbed = (): EmbeddingModel =>
  tagModel(
    new MockEmbeddingModelV4({
      provider: "ollama",
      modelId: "bge-m3",
      maxEmbeddingsPerCall: 256,
      doEmbed: async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
    }),
    { role: "embed", provider: "ollama", model: "bge-m3" },
  );

describeEachDb("digest runs", (f) => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(f);
    routeFake(t.fake, { digest: () => DIGEST_REPLY, classify: classifyReply });
  });
  afterEach(() => t.close());

  const submit = (over: Record<string, unknown> = {}) =>
    t.req("/v1/transcripts/digest", { json: transcriptInput(over) });
  const run = async (id: string) =>
    ((await (await t.req(`/v1/activity/${id}`)).json()) as { run: Run }).run;

  it("records a succeeded run with the digest id", async () => {
    const res = await submit();
    expect(res.status).toBe(200);
    const out = (await res.json()) as { digest_id: string; run_id: string };
    expect(res.headers.get("pama-run-id")).toBe(out.run_id);
    const r = await run(out.run_id);
    expect(r).toMatchObject({
      kind: "transcript",
      stage: "stored",
      status: "succeeded",
      digest_id: out.digest_id,
      error_code: null,
      resumable: false,
      attempts: 1,
    });
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("keeps the draft when embedding fails and resumes from embed on retry", async () => {
    const embed = t.deps.models.embed;
    t.deps.models.embed = unreachableEmbed();
    const res = await submit();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("provider_unreachable");
    const id = res.headers.get("pama-run-id") as string;
    const failed = await run(id);
    expect(failed).toMatchObject({
      status: "failed",
      stage: "classified",
      error_code: "provider_unreachable",
      role: "embed",
      provider: "ollama",
      model: "bge-m3",
      resumable: true,
    });
    const failedList = (await (await t.req("/v1/activity?status=failed")).json()) as {
      runs: Run[];
      counts: { failed: number };
    };
    expect(failedList.runs.map((x) => x.id)).toEqual([id]);
    expect(failedList.counts.failed).toBe(1);

    t.deps.models.embed = embed;
    const calls = t.fake.calls.length;
    const retry = await t.req(`/v1/activity/${id}/retry`, { method: "POST" });
    expect(retry.status).toBe(200);
    const done = (await retry.json()) as { digest_id: string; status: string };
    expect(done.status).toBe("draft");
    expect(t.fake.calls.length).toBe(calls); // no drafting or classifying again
    expect(await run(id)).toMatchObject({
      status: "succeeded",
      stage: "stored",
      digest_id: done.digest_id,
      attempts: 2,
      resumable: false,
    });
    const items = await t.db.query("SELECT id FROM digest_items WHERE digest_id = $1", [
      done.digest_id,
    ]);
    expect(items.length).toBeGreaterThan(0);
    // The same request again is a no-op returning the stored digest.
    const again = (await (await submit()).json()) as { digest_id: string };
    expect(again.digest_id).toBe(done.digest_id);
  });

  it("a device resubmission after an embed failure skips the model calls", async () => {
    const embed = t.deps.models.embed;
    t.deps.models.embed = unreachableEmbed();
    expect((await submit()).status).toBe(502);
    t.deps.models.embed = embed;
    const calls = t.fake.calls.length;
    const res = await submit();
    expect(res.status).toBe(200);
    expect(t.fake.calls.length).toBe(calls);
    const runs = (await (await t.req("/v1/activity")).json()) as {
      runs: Run[];
      counts: { failed: number; awaiting_review: number };
    };
    expect(runs.runs.map((r) => r.status)).toEqual(["succeeded", "failed"]);
    expect(runs.runs[1]?.resumable).toBe(false); // consumed
    expect(runs.counts).toMatchObject({ failed: 0, awaiting_review: 1 });
  });

  it("a drafting failure is recorded and can only be retried on the device", async () => {
    routeFake(t.fake, {});
    const res = await submit();
    expect(res.status).toBe(500);
    const id = res.headers.get("pama-run-id") as string;
    expect(await run(id)).toMatchObject({
      status: "failed",
      stage: "received",
      error_code: "internal",
      resumable: false,
    });
    const retry = await t.req(`/v1/activity/${id}/retry`, { method: "POST" });
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { error: { code: string } }).error.code).toBe(
      "retry_on_device",
    );
  });

  it("two concurrent retries of one run store the draft once", async () => {
    const embed = t.deps.models.embed;
    t.deps.models.embed = unreachableEmbed();
    const res = await submit();
    expect(res.status).toBe(502);
    const id = res.headers.get("pama-run-id") as string;
    t.deps.models.embed = embed;
    const [a, b] = await Promise.all([
      t.req(`/v1/activity/${id}/retry`, { method: "POST" }),
      t.req(`/v1/activity/${id}/retry`, { method: "POST" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const digests = await t.db.query("SELECT id FROM digests");
    expect(digests).toHaveLength(1);
    expect(await run(id)).toMatchObject({ status: "succeeded", attempts: 2 });
    // A retry of a run that already succeeded is refused too.
    const late = await t.req(`/v1/activity/${id}/retry`, { method: "POST" });
    expect(late.status).toBe(409);
  });

  it("refuses to resume a run that a newer run of the session replaced", async () => {
    const embed = t.deps.models.embed;
    t.deps.models.embed = unreachableEmbed();
    const res = await submit();
    const stale = res.headers.get("pama-run-id") as string;
    t.deps.models.embed = embed;
    // The device re-sends the session after more work (different transcript, new draft).
    const events = [
      ...(transcriptInput().events as unknown[]),
      { kind: "user", text: "And for partial refunds, keep the same rule?" },
      {
        kind: "assistant",
        text: "Yes, the shipping fee stays non-refundable for partial refunds.",
      },
    ];
    const fresh = await submit({ events });
    expect(fresh.status).toBe(200);
    const newer = fresh.headers.get("pama-run-id") as string;
    const before = await t.db.query("SELECT id FROM digests");
    const retry = await t.req(`/v1/activity/${stale}/retry`, { method: "POST" });
    expect(retry.status).toBe(409);
    const body = (await retry.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("superseded");
    expect(body.error.message).toContain(newer);
    expect(await t.db.query("SELECT id FROM digests")).toHaveLength(before.length);
    expect((await run(stale)).status).toBe("failed");
  });

  it("completing the same kept draft twice reuses the stored version", async () => {
    const embed = t.deps.models.embed;
    t.deps.models.embed = unreachableEmbed();
    const res = await submit();
    const id = res.headers.get("pama-run-id") as string;
    t.deps.models.embed = embed;
    const [row] = await t.db.query<{ resume: ResumeState }>(
      "SELECT resume FROM digest_runs WHERE id = $1",
      [id],
    );
    const state = row?.resume as ResumeState;
    const first = await completeDigest(t.deps, state);
    const second = await completeDigest(t.deps, state);
    expect(second).toEqual(first);
    expect(await t.db.query("SELECT id FROM digests")).toHaveLength(1);
  });

  it("paginates newest first and filters by since", async () => {
    for (const s of ["a", "b", "c"]) {
      expect((await submit({ agent_session_id: `sess-${s}` })).status).toBe(200);
    }
    const p1 = (await (await t.req("/v1/activity?limit=2")).json()) as {
      runs: Run[];
      next_cursor: string | null;
    };
    expect(p1.runs).toHaveLength(2);
    expect(p1.next_cursor).toBe(p1.runs[1]?.id);
    const p2 = (await (await t.req(`/v1/activity?limit=2&cursor=${p1.next_cursor}`)).json()) as {
      runs: Run[];
      next_cursor: string | null;
    };
    expect(p2.runs).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    const future = new Date(Date.now() + 60_000).toISOString();
    const none = (await (
      await t.req(`/v1/activity?since=${encodeURIComponent(future)}`)
    ).json()) as { runs: Run[] };
    expect(none.runs).toHaveLength(0);
    expect((await t.req("/v1/activity?status=bogus")).status).toBe(422);
    expect((await t.req("/v1/activity/nope")).status).toBe(404);
  });

  it("streams counts, run updates and heartbeats over SSE", async () => {
    const saved = events.heartbeatMs;
    events.heartbeatMs = 50;
    const ac = new AbortController();
    try {
      const res = await t.app.request("/v1/events", {
        headers: { authorization: `Bearer ${t.deps.config.localToken}` },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let text = "";
      const until = async (needle: string) => {
        const deadline = Date.now() + 5_000;
        while (!text.includes(needle)) {
          if (Date.now() > deadline) throw new Error(`no ${needle} in: ${text}`);
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          text += dec.decode(value);
        }
      };
      await until("event: review.count");
      await until("event: inbox.count");
      expect(text).toContain('"awaiting_review":0');
      expect((await submit()).status).toBe(200);
      await until('"status":"succeeded"');
      expect(text).toContain("event: run.updated");
      await until('"awaiting_review":1');
      await until("event: heartbeat");
      await reader.cancel();
    } finally {
      ac.abort();
      events.heartbeatMs = saved;
    }
  });
});
