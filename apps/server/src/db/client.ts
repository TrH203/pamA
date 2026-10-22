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

export interface Db {
  kind: "pg" | "pglite";
  /** Connection string (pg only), for components that open their own pool (pg-boss). */
  url?: string;
  orm: Orm;
  /** Run one or more SQL statements without parameters. */
  exec(sql: string): Promise<void>;
  /** Run one parameterized statement and return its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const client = await PGlite.create({ dataDir, extensions: { vector } });
  return {
    kind: "pglite",
    orm: drizzlePglite({ client, schema }) as unknown as Orm,
    exec: async (sql) => {
      await client.exec(sql);
    },
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await client.query<T>(sql, params)).rows,
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
    close: () => pool.end(),
  };
}

export async function openDb(config: Config): Promise<Db> {
  if (config.databaseUrl) return openPg(config.databaseUrl);
  return openPglite(`${config.dataDir}/pglite`);
}
