// Local-mode queue: a `jobs` table polled by one in-process worker loop.
import { ulid } from "ulid";
import type { Db } from "../db/client.ts";
import {
  DEFAULT_RETRY_LIMIT,
  type Job,
  type JobQueue,
  type QueueOptions,
  type SendOptions,
} from "./index.ts";

interface Row {
  id: string;
  name: string;
  payload: { data: unknown; retryLimit: number };
  attempts: number;
}

export class InProcessQueue implements JobQueue {
  private readonly handlers = new Map<string, (job: Job<unknown>) => Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private readonly pollMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly db: Db,
    opts: QueueOptions,
  ) {
    this.pollMs = opts.pollMs ?? 500;
    this.retryDelayMs = opts.retryDelayMs ?? 5_000;
  }

  async start() {
    this.stopped = false;
    // Jobs left `running` by a crash are retried.
    await this.db.exec("UPDATE jobs SET status = 'queued' WHERE status = 'running'");
    this.schedule();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }

  async send<T extends object>(name: string, data: T, o: SendOptions = {}) {
    const id = ulid();
    const runAt = new Date(Date.now() + (o.startAfterSeconds ?? 0) * 1_000);
    await this.db.query("INSERT INTO jobs (id, name, payload, run_at) VALUES ($1, $2, $3, $4)", [
      id,
      name,
      JSON.stringify({ data, retryLimit: o.retryLimit ?? DEFAULT_RETRY_LIMIT }),
      runAt.toISOString(),
    ]);
    return id;
  }

  async work<T>(name: string, handler: (job: Job<T>) => Promise<void>) {
    this.handlers.set(name, handler as (job: Job<unknown>) => Promise<void>);
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
  }

  private async tick() {
    this.running = true;
    try {
      while (!this.stopped && (await this.runOne())) {}
    } catch (e) {
      console.error("queue:", e);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async runOne(): Promise<boolean> {
    const names = [...this.handlers.keys()];
    if (!names.length) return false;
    const [row] = await this.db.query<Row>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() AND name = ANY($1)
                   ORDER BY run_at, id LIMIT 1)
       RETURNING id, name, payload, attempts`,
      [names],
    );
    if (!row) return false;
    const handler = this.handlers.get(row.name);
    const retryCount = row.attempts - 1;
    try {
      await handler?.({ id: row.id, name: row.name, data: row.payload.data, retryCount });
      await this.db.query("UPDATE jobs SET status = 'done' WHERE id = $1", [row.id]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (retryCount < row.payload.retryLimit) {
        const delay = this.retryDelayMs * 2 ** retryCount;
        await this.db.query(
          "UPDATE jobs SET status = 'queued', last_error = $2, run_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1",
          [row.id, msg, String(delay)],
        );
      } else {
        await this.db.query("UPDATE jobs SET status = 'failed', last_error = $2 WHERE id = $1", [
          row.id,
          msg,
        ]);
      }
    }
    return true;
  }
}
