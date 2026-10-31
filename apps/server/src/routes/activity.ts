// Pipeline activity (spec 006): digest runs, retry, and the live event stream for the console.
//   GET  /v1/activity?status=&since=&cursor=&limit=   runs, newest first, paginated
//   GET  /v1/activity/:id                              one run
//   POST /v1/activity/:id/retry                        resume a failed run from its kept draft
//   GET  /v1/events                                    SSE: run.updated, review.count, inbox.count
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { completeDigest, type ResumeState } from "../pipeline/complete.ts";
import {
  listRuns,
  loadRun,
  type PipelineCounts,
  pipelineCounts,
  type RunEvent,
  type RunKind,
  type RunTracker,
  reopenRun,
  runBus,
  startRun,
} from "../services/runs.ts";

/** Response header carrying the run id of a digest request (also on errors). */
export const RUN_HEADER = "pama-run-id";

/**
 * Record a digest request as a run: stages are written by `fn` through the tracker, the outcome
 * (digest id or coded error) when it returns or throws. The HTTP call stays synchronous.
 */
export async function tracked<T extends { digest_id: string }>(
  c: Context<Env>,
  who: { kind: RunKind; agent: string; agent_session_id: string; project_key?: string | null },
  fn: (run: RunTracker) => Promise<T>,
): Promise<T & { run_id: string }> {
  const { db, workspaceId } = c.get("deps");
  const run = await startRun(db, workspaceId, who);
  c.header(RUN_HEADER, run.id);
  try {
    const out = await fn(run);
    await run.succeed(out.digest_id);
    return { ...out, run_id: run.id };
  } catch (err) {
    await run.fail(err).catch((e) => console.error("cannot record run failure", e));
    throw err;
  }
}

const ListQuery = z.object({
  status: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Heartbeat and count refresh interval of `/v1/events` (tests shorten it). */
export const events = { heartbeatMs: 15_000 };

export const activityRoutes = new Hono<Env>()
  .get("/activity", async (c) => {
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) throw new HttpError(422, "invalid_request", q.error.message);
    const { db, workspaceId } = c.get("deps");
    const page = await listRuns(db, workspaceId, q.data);
    return c.json({ ...page, counts: await pipelineCounts(db, workspaceId) });
  })
  .get("/activity/:id", async (c) => {
    const { db, workspaceId } = c.get("deps");
    const run = await loadRun(db, workspaceId, c.req.param("id"));
    if (!run) throw new HttpError(404, "not_found", "no run with this id");
    return c.json({ run });
  })
  .post("/activity/:id/retry", async (c) => {
    const deps = c.get("deps");
    const id = c.req.param("id");
    const run = await loadRun(deps.db, deps.workspaceId, id);
    if (!run) throw new HttpError(404, "not_found", "no run with this id");
    if (run.status !== "failed") {
      throw new HttpError(409, "conflict", `cannot retry a ${run.status} run`);
    }
    const [row] = await deps.db.query<{ resume: ResumeState | null }>(
      "SELECT resume FROM digest_runs WHERE id = $1",
      [id],
    );
    if (!row?.resume) {
      // The transcript never leaves the device (Constitution I): only it can start over.
      throw new HttpError(
        409,
        "retry_on_device",
        "This run failed before its draft was kept, so it needs the session from the device. Run `pama activity retry --all-failed` on that device.",
      );
    }
    const tracker = await reopenRun(deps.db, deps.workspaceId, id);
    c.header(RUN_HEADER, id);
    try {
      const out = await completeDigest(deps, row.resume, tracker);
      await tracker.succeed(out.digest_id);
      return c.json({ ...out, run_id: id });
    } catch (err) {
      await tracker.fail(err);
      throw err;
    }
  })
  .get("/events", (c) => {
    const { db, workspaceId } = c.get("deps");
    return streamSSE(c, async (stream) => {
      let last: PipelineCounts | null = null;
      const sendCounts = async () => {
        const n = await pipelineCounts(db, workspaceId);
        if (!last || n.awaiting_review !== last.awaiting_review || n.failed !== last.failed) {
          await stream.writeSSE({
            event: "review.count",
            data: JSON.stringify({ awaiting_review: n.awaiting_review, failed: n.failed }),
          });
        }
        if (!last || n.forwarded !== last.forwarded) {
          await stream.writeSSE({
            event: "inbox.count",
            data: JSON.stringify({ forwarded: n.forwarded }),
          });
        }
        last = n;
      };
      // Writes are serialized so events never interleave.
      let chain: Promise<unknown> = Promise.resolve();
      const enqueue = (fn: () => Promise<unknown>) => {
        chain = chain.then(fn).catch(() => undefined);
        return chain;
      };
      const onRun = (e: RunEvent) => {
        if (e.workspaceId !== workspaceId) return;
        void enqueue(async () => {
          await stream.writeSSE({
            event: "run.updated",
            id: e.run.id,
            data: JSON.stringify(e.run),
          });
          if (e.run.status === "succeeded" || e.run.status === "failed") await sendCounts();
        });
      };
      runBus.on("run", onRun);
      stream.onAbort(() => {
        runBus.off("run", onRun);
      });
      await enqueue(sendCounts);
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(events.heartbeatMs);
        if (stream.aborted || stream.closed) break;
        await enqueue(async () => {
          await stream.writeSSE({ event: "heartbeat", data: String(Date.now()) });
          await sendCounts();
        });
      }
      runBus.off("run", onRun);
    });
  });
