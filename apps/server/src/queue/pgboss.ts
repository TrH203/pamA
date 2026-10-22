import { PgBoss } from "pg-boss";
import {
  DEFAULT_RETRY_LIMIT,
  type Job,
  type JobQueue,
  type QueueOptions,
  type SendOptions,
} from "./index.ts";

export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly created = new Set<string>();

  constructor(
    url: string,
    private readonly opts: QueueOptions,
  ) {
    this.boss = new PgBoss({ connectionString: url, schema: "pgboss" });
    this.boss.on("error", (e) => console.error("pg-boss:", e));
  }

  async start() {
    await this.boss.start();
  }

  async stop() {
    await this.boss.stop({ graceful: true, timeout: 5_000 });
  }

  private async ensure(name: string) {
    if (this.created.has(name)) return;
    await this.boss.createQueue(name);
    this.created.add(name);
  }

  async send<T extends object>(name: string, data: T, o: SendOptions = {}) {
    await this.ensure(name);
    const id = await this.boss.send(name, data, {
      retryLimit: o.retryLimit ?? DEFAULT_RETRY_LIMIT,
      retryDelay: Math.max(1, Math.round((this.opts.retryDelayMs ?? 1_000) / 1_000)),
      retryBackoff: true,
      startAfter: o.startAfterSeconds,
    });
    if (!id) throw new Error(`pg-boss refused job ${name}`);
    return id;
  }

  async work<T>(name: string, handler: (job: Job<T>) => Promise<void>) {
    await this.ensure(name);
    await this.boss.work<T>(
      name,
      { pollingIntervalSeconds: Math.max(0.5, (this.opts.pollMs ?? 2_000) / 1_000) },
      async (jobs) => {
        for (const j of jobs) {
          await handler({ id: j.id, name: j.name, data: j.data, retryCount: j.retryCount });
        }
      },
    );
  }
}
