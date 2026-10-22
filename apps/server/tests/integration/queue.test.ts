import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/client.ts";
import { createQueue, type JobQueue } from "../../src/queue/index.ts";
import { describeEachDb } from "../helpers/db.ts";

describeEachDb("JobQueue", (f) => {
  let db: Db;
  let q: JobQueue;

  beforeEach(async () => {
    db = await f.create();
    q = createQueue(db, { pollMs: 50, retryDelayMs: 50 });
    await q.start();
  });

  afterEach(async () => {
    await q.stop();
    await db.close();
  });

  it("delivers a job to its worker once", async () => {
    const seen: unknown[] = [];
    await q.work<{ n: number }>("digest", async (job) => {
      seen.push(job.data);
    });
    await q.send("digest", { n: 1 });
    await vi.waitFor(() => expect(seen).toEqual([{ n: 1 }]), { timeout: 10_000, interval: 50 });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(1);
  });

  it("retries a failing job until it succeeds", async () => {
    let calls = 0;
    await q.work("flaky", async () => {
      calls++;
      if (calls < 3) throw new Error("model unavailable");
    });
    await q.send("flaky", {}, { retryLimit: 5 });
    await vi.waitFor(() => expect(calls).toBe(3), { timeout: 20_000, interval: 50 });
  });

  it("gives up after the retry limit", async () => {
    let calls = 0;
    await q.work("broken", async () => {
      calls++;
      throw new Error("always");
    });
    await q.send("broken", {}, { retryLimit: 1 });
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 20_000, interval: 50 });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(2);
  });
});
