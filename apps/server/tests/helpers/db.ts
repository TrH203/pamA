// Run integration tests against both storage adapters. Postgres runs only when
// PAMA_TEST_PG_URL is set (CI service container, or `docker run pgvector/pgvector:pg16`).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";
import { type Db, openPg, openPglite } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";

export const PG_URL = process.env.PAMA_TEST_PG_URL;

export interface DbFactory {
  kind: "pglite" | "pg";
  /** A fresh, migrated database. */
  create(): Promise<Db>;
}

export const pglite: DbFactory = {
  kind: "pglite",
  async create() {
    const db = await openPglite();
    await migrate(db);
    return db;
  },
};

const postgres: DbFactory = {
  kind: "pg",
  async create() {
    if (!PG_URL) throw new Error("PAMA_TEST_PG_URL not set");
    // One throwaway database per test file keeps runs independent.
    const name = `pama_t_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(PG_URL);
    url.pathname = `/${name}`;
    const db = await openPg(url.toString());
    await migrate(db);
    return db;
  },
};

export const factories: DbFactory[] = PG_URL ? [pglite, postgres] : [pglite];

/** `describe` once per available adapter. */
export function describeEachDb(title: string, fn: (f: DbFactory) => void) {
  for (const f of factories) describe(`${title} [${f.kind}]`, () => fn(f));
}
