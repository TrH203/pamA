// Spike R4 (research.md): does PGlite 0.5 + pglite-pgvector support an HNSW index, and does RLS
// filter rows for a non-superuser role switched in per transaction?
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create({ extensions: { vector } });
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE items (id text PRIMARY KEY, session_id text NOT NULL, embedding vector(3));
    INSERT INTO items VALUES
      ('a', 's1', '[1,0,0]'), ('b', 's1', '[0.9,0.1,0]'), ('c', 's2', '[1,0,0]');
  `);
});

afterAll(async () => {
  await db.close();
});

describe("spike R4", () => {
  it("creates and uses an HNSW cosine index", async () => {
    await db.exec("CREATE INDEX items_hnsw ON items USING hnsw (embedding vector_cosine_ops)");
    await db.exec("SET enable_seqscan = off");
    const plan = await db.query<{ "QUERY PLAN": string }>(
      "EXPLAIN SELECT id FROM items ORDER BY embedding <=> '[1,0,0]' LIMIT 2",
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    await db.exec("RESET enable_seqscan");
    expect(text).toMatch(/items_hnsw/);
    const res = await db.query<{ id: string }>(
      "SELECT id FROM items ORDER BY embedding <=> '[1,0,0]' LIMIT 3",
    );
    expect(res.rows.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("enforces RLS for a non-superuser role with SET ROLE per transaction", async () => {
    await db.exec(`
      CREATE ROLE pama_app NOLOGIN;
      GRANT SELECT ON items TO pama_app;
      ALTER TABLE items ENABLE ROW LEVEL SECURITY;
      CREATE POLICY scope ON items FOR SELECT TO pama_app
        USING (session_id = ANY (string_to_array(current_setting('pama.allowed_session_ids', true), ',')));
    `);
    const rows = await db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE pama_app");
      await tx.exec("SELECT set_config('pama.allowed_session_ids', 's1', true)");
      return (await tx.query<{ id: string }>("SELECT id FROM items ORDER BY id")).rows;
    });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);

    const none = await db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE pama_app");
      return (await tx.query<{ id: string }>("SELECT id FROM items")).rows;
    });
    expect(none).toEqual([]);

    // Back outside the transaction the superuser sees everything again.
    const all = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM items");
    expect(all.rows[0]?.n).toBe(3);
  });
});
