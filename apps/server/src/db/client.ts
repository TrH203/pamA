// Db adapter: node-postgres (self-host, cloud) or PGlite (local sidecar), same SQL and schema.
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import type { Config } from "../config.ts";
import * as schema from "./schema/index.ts";

export type Schema = typeof schema;
export type Orm = PgDatabase<PgQueryResultHKT, Schema>;

/** What a statement runner needs; implemented by Db and by a transaction handle. */
export interface Queryable {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  kind: "pg" | "pglite";
  /** Connection string (pg only), for components that open their own pool (pg-boss). */
  url?: string;
  orm: Orm;
  /** Run one or more SQL statements without parameters. */
  exec(sql: string): Promise<void>;
  /** Run one parameterized statement and return its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run `fn` in one transaction; rolled back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** PGlite assets embedded in the compiled sidecar (research R6); unset when running from npm. */
export interface PgliteAssets {
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
  fsBundle: Blob;
  /** pgvector bundle on disk (PGlite cannot open files inside the compiled binary). */
  vectorBundle: URL;
}

let embedded: PgliteAssets | undefined;

export function usePgliteAssets(a: PgliteAssets) {
  embedded = a;
}

export async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const client = embedded
    ? await PGlite.create({
        dataDir,
        pgliteWasmModule: embedded.pgliteWasmModule,
        initdbWasmModule: embedded.initdbWasmModule,
        fsBundle: embedded.fsBundle,
        extensions: {
          vector: {
            name: "vector",
            setup: async (_pg, emscriptenOpts) => ({
              emscriptenOpts,
              bundlePath: (embedded as PgliteAssets).vectorBundle,
            }),
          },
        },
      })
    : await PGlite.create({ dataDir, extensions: { vector } });
  return {
    kind: "pglite",
    orm: drizzlePglite({ client, schema }) as unknown as Orm,
    exec: async (sql) => {
      await client.exec(sql);
    },
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await client.query<T>(sql, params)).rows,
    tx: (fn) =>
      client.transaction((t) =>
        fn({
          exec: async (sql) => {
            await t.exec(sql);
          },
          query: async <T>(sql: string, params: unknown[] = []) =>
            (await t.query<T>(sql, params)).rows,
        }),
      ),
    close: () => client.close(),
  };
}

export async function openPg(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    kind: "pg",
    url,
    orm: drizzlePg({ client: pool, schema }) as unknown as Orm,
    exec: async (sql) => {
      await pool.query(sql);
    },
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await pool.query(sql, params)).rows as T[],
    tx: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn({
          exec: async (sql) => {
            await c.query(sql);
          },
          query: async <T>(sql: string, params: unknown[] = []) =>
            (await c.query(sql, params)).rows as T[],
        });
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function openDb(config: Config): Promise<Db> {
  if (config.databaseUrl) return openPg(config.databaseUrl);
  return openPglite(`${config.dataDir}/pglite`);
}
