// Applies migrations/*.sql in order on pg and PGlite alike. Each file runs in one transaction and
// is recorded in pama_migrations. Files are split on drizzle-kit's statement breakpoints.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./client.ts";

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS_DIR =
  process.env.PAMA_MIGRATIONS_DIR ?? join(import.meta.dirname, "../../migrations");

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

export async function migrate(db: Db, migrations = loadMigrations()): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS pama_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const done = new Set(
    (await db.query<{ name: string }>("SELECT name FROM pama_migrations")).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    const statements = m.sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    const body = statements.join(";\n").replace(/;\s*;/g, ";");
    await db.exec(
      `BEGIN;\n${body};\nINSERT INTO pama_migrations (name) VALUES ('${m.name}');\nCOMMIT;`,
    );
    applied.push(m.name);
  }
  return applied;
}
