// First-run workspace bootstrap (US5). Local: one workspace without an email. Self-host: one
// workspace owned by PAMA_OWNER_EMAIL. Cloud: the same default workspace for the operator's owner
// token; every email that signs in gets its own workspace (auth/magic-link.ts).
import { ulid } from "ulid";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { bootstrapLocal } from "./bootstrap-local.ts";

export async function bootstrap(db: Db, config: Config, localModels: boolean): Promise<string> {
  if (config.mode === "local") return bootstrapLocal(db, localModels);
  const email = config.ownerEmail?.toLowerCase();
  if (email) {
    const [ws] = await db.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_email = $1",
      [email],
    );
    if (ws) return ws.id;
    const [unclaimed] = await db.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_email IS NULL ORDER BY created_at LIMIT 1",
    );
    if (unclaimed) {
      await db.query("UPDATE workspaces SET owner_email = $2 WHERE id = $1", [unclaimed.id, email]);
      return unclaimed.id;
    }
    const id = ulid();
    await db.query(
      "INSERT INTO workspaces (id, owner_email, display_name, answer_threshold) VALUES ($1, $2, $3, $4)",
      [id, email, email.split("@")[0] ?? "the owner", localModels ? 0.8 : 0.7],
    );
    return id;
  }
  return bootstrapLocal(db, localModels);
}
