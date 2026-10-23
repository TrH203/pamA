// Local mode has exactly one workspace with no owner email (data-model.md). Create it on first run.
import { ulid } from "ulid";
import type { Db } from "../db/client.ts";

export async function bootstrapLocal(db: Db, local = true): Promise<string> {
  const [ws] = await db.query<{ id: string }>(
    "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
  );
  if (ws) return ws.id;
  const id = ulid();
  await db.query("INSERT INTO workspaces (id, answer_threshold) VALUES ($1, $2)", [
    id,
    local ? 0.8 : 0.7,
  ]);
  return id;
}
