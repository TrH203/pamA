// Migration 0013 backfill: link asks → one conversation per (link, visitor); hotkey asks → one
// conversation per workspace and UTC day; orphans keep a null conversation.
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Db } from "../../src/db/client.ts";
import { loadMigrations, migrate } from "../../src/db/migrate.ts";
import { describeEachDb } from "../helpers/db.ts";

describeEachDb("migration 0013 conversations backfill", (f) => {
  let db: Db;
  beforeEach(async () => {
    // `create` migrates fully: roll 0013 back by dropping what it added, seed asks as they were
    // before conversations existed, then let `migrate` apply 0013 again.
    db = await f.create();
    expect(loadMigrations().some((m) => m.name === "0013_conversations.sql")).toBe(true);
    await db.exec(`
      ALTER TABLE asks DROP CONSTRAINT asks_conversation_id_conversations_id_fk;
      DROP INDEX asks_conversation_time;
      ALTER TABLE asks DROP COLUMN conversation_id;
      DROP TABLE conversations;
      ALTER TABLE asks DROP CONSTRAINT asks_origin;
      ALTER TABLE asks ADD CONSTRAINT asks_origin CHECK (origin IN ('link','hotkey'));
      ALTER TABLE workspaces DROP CONSTRAINT workspaces_ask_retention_days;
      ALTER TABLE workspaces DROP COLUMN ask_retention_days;
      DELETE FROM pama_migrations WHERE name = '0013_conversations.sql';
    `);
  });
  afterEach(() => db.close());

  it("groups link asks by (link, visitor) and hotkey asks by day", async () => {
    await db.query("INSERT INTO workspaces (id) VALUES ('ws1')");
    await db.query(
      `INSERT INTO ask_links (slug, workspace_id, title, source_refs, access_mode, expires_at)
       VALUES ('linkslug01', 'ws1', 'Refunds', '[]', 'open', now() + interval '1 day')`,
    );
    const ask = (id: string, origin: string, at: string, link?: string, visitor?: string) =>
      db.query(
        `INSERT INTO asks (id, workspace_id, origin, link_slug, visitor_id, question, status, created_at)
         VALUES ($1, 'ws1', $2, $3, $4, $5, 'answered', $6)`,
        [id, origin, link ?? null, visitor ?? null, `question ${id}`, at],
      );
    await ask("a1", "link", "2026-10-01T10:00:00Z", "linkslug01", "v1");
    await ask("a2", "link", "2026-10-01T11:00:00Z", "linkslug01", "v1");
    await ask("a3", "link", "2026-10-02T10:00:00Z", "linkslug01", "v2");
    await ask("a4", "link", "2026-10-02T10:00:00Z", "gonelink99", "v3"); // link deleted
    await ask("h1", "hotkey", "2026-10-01T01:00:00Z");
    await ask("h2", "hotkey", "2026-10-01T23:00:00Z");
    await ask("h3", "hotkey", "2026-10-02T00:30:00Z");

    expect(await migrate(db)).toContain("0013_conversations.sql");

    const rows = await db.query<{ id: string; conversation_id: string | null }>(
      "SELECT id, conversation_id FROM asks ORDER BY id",
    );
    const conv = Object.fromEntries(rows.map((r) => [r.id, r.conversation_id]));
    expect(conv.a1).toBeTruthy();
    expect(conv.a1).toBe(conv.a2);
    expect(conv.a3).not.toBe(conv.a1);
    expect(conv.a4).toBeNull();
    expect(conv.h1).toBe(conv.h2);
    expect(conv.h3).not.toBe(conv.h1);

    const convs = await db.query<{
      id: string;
      origin: string;
      link_slug: string | null;
      visitor_id: string | null;
      title: string;
      created_at: Date;
      last_at: Date;
    }>("SELECT * FROM conversations ORDER BY created_at, origin");
    expect(convs).toHaveLength(4);
    const first = convs.find((c) => c.id === conv.a1);
    expect(first).toMatchObject({ origin: "link", link_slug: "linkslug01", visitor_id: "v1" });
    expect(first?.title).toBe("question a1");
    expect(new Date(first?.last_at as Date).toISOString()).toBe("2026-10-01T11:00:00.000Z");
    const day = convs.find((c) => c.id === conv.h1);
    expect(day).toMatchObject({ origin: "hotkey", title: "Drafts 2026-10-01" });

    const [w] = await db.query<{ d: number }>(
      "SELECT ask_retention_days AS d FROM workspaces WHERE id = 'ws1'",
    );
    expect(w?.d).toBe(180);
    // New origin is accepted.
    await db.query(
      `INSERT INTO asks (id, workspace_id, origin, question, status) VALUES ('o1', 'ws1', 'owner_chat', 'q', 'answered')`,
    );
  });
});
