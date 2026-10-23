// JobQueue: pg-boss on Postgres (self-host, cloud), an in-process worker on PGlite (local mode,
// single connection). Research R5.
import type { Db } from "../db/client.ts";
import { InProcessQueue } from "./inprocess.ts";
import { PgBossQueue } from "./pgboss.ts";

export interface Job<T> {
  id: string;
  name: string;
  data: T;
  /** 0 on the first attempt. */
  retryCount: number;
}

export interface SendOptions {
  /** Extra attempts after the first one fails. Default 5 (data-model: max 5 retries). */
  retryLimit?: number;
  startAfterSeconds?: number;
}

export interface JobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  send<T extends object>(name: string, data: T, opts?: SendOptions): Promise<string>;
  work<T>(name: string, handler: (job: Job<T>) => Promise<void>): Promise<void>;
}

export interface QueueOptions {
  pollMs?: number;
  /** Base delay before a retry; doubles per attempt. */
  retryDelayMs?: number;
}

export const DEFAULT_RETRY_LIMIT = 5;

export function createQueue(db: Db, opts: QueueOptions = {}): JobQueue {
  if (db.kind === "pg") {
    if (!db.url) throw new Error("pg Db without url");
    return new PgBossQueue(db.url, opts);
  }
  return new InProcessQueue(db, opts);
}
