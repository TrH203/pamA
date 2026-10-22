// Bundles group the sessions of one task (by git branch); owners can rename, split and merge.
import { ulid } from "ulid";
import type { Db, Queryable } from "../db/client.ts";
import { HttpError } from "../http.ts";

export async function assignBundle(
  q: Queryable,
  workspaceId: string,
  projectId: string,
  key: string,
): Promise<string> {
  const [b] = await q.query<{ id: string }>(
    `INSERT INTO bundles (id, workspace_id, project_id, name, key) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (project_id, key) WHERE key IS NOT NULL DO UPDATE SET key = excluded.key
     RETURNING id`,
    [ulid(), workspaceId, projectId, key],
  );
  return (b as { id: string }).id;
}

async function owned(q: Queryable, workspaceId: string, ids: string[]) {
  const rows = await q.query<{ id: string; project_id: string }>(
    "SELECT id, project_id FROM bundles WHERE workspace_id = $1 AND id = ANY($2)",
    [workspaceId, ids],
  );
  if (rows.length !== new Set(ids).size) throw new HttpError(404, "not_found", "bundle not found");
  return rows;
}

export async function renameBundle(db: Db, workspaceId: string, id: string, name: string) {
  await owned(db, workspaceId, [id]);
  await db.query("UPDATE bundles SET name = $2 WHERE id = $1", [id, name]);
}

async function moveSessions(q: Queryable, sessionIds: string[], bundleId: string) {
  await q.query("UPDATE sessions SET bundle_id = $2 WHERE id = ANY($1)", [sessionIds, bundleId]);
  await q.query("UPDATE digest_items SET bundle_id = $2 WHERE session_id = ANY($1)", [
    sessionIds,
    bundleId,
  ]);
}

export async function splitBundle(
  db: Db,
  workspaceId: string,
  id: string,
  sessionIds: string[],
  newName: string,
): Promise<string> {
  const [b] = await owned(db, workspaceId, [id]);
  const inBundle = await db.query<{ id: string }>(
    "SELECT id FROM sessions WHERE bundle_id = $1 AND id = ANY($2)",
    [id, sessionIds],
  );
  if (!sessionIds.length || inBundle.length !== sessionIds.length) {
    throw new HttpError(422, "invalid_request", "sessions must belong to the bundle");
  }
  return db.tx(async (q) => {
    const newId = ulid();
    await q.query(
      "INSERT INTO bundles (id, workspace_id, project_id, name, key, sync_enabled) SELECT $1, workspace_id, project_id, $2, NULL, sync_enabled FROM bundles WHERE id = $3",
      [newId, newName, b?.id],
    );
    await moveSessions(q, sessionIds, newId);
    return newId;
  });
}

export async function mergeBundles(
  db: Db,
  workspaceId: string,
  ids: string[],
  name: string,
): Promise<string> {
  const rows = await owned(db, workspaceId, ids);
  if (new Set(rows.map((r) => r.project_id)).size !== 1) {
    throw new HttpError(422, "invalid_request", "bundles must belong to the same project");
  }
  const [target, ...rest] = ids as [string, ...string[]];
  return db.tx(async (q) => {
    const sessions = await q.query<{ id: string }>(
      "SELECT id FROM sessions WHERE bundle_id = ANY($1)",
      [rest],
    );
    await moveSessions(
      q,
      sessions.map((s) => s.id),
      target,
    );
    await q.query("DELETE FROM bundles WHERE id = ANY($1)", [rest]);
    await q.query("UPDATE bundles SET name = $2 WHERE id = $1", [target, name]);
    return target;
  });
}

export async function listBundles(db: Db, workspaceId: string) {
  const bundles = await db.query<{
    id: string;
    name: string;
    key: string | null;
    project_id: string;
    project: string;
  }>(
    `SELECT b.id, b.name, b.key, b.project_id, p.name AS project
     FROM bundles b JOIN projects p ON p.id = b.project_id
     WHERE b.workspace_id = $1 ORDER BY b.created_at, b.id`,
    [workspaceId],
  );
  const sessions = await db.query<{
    id: string;
    bundle_id: string;
    agent: string;
    agent_session_id: string;
    ended_at: Date | null;
  }>(
    "SELECT id, bundle_id, agent, agent_session_id, ended_at FROM sessions WHERE workspace_id = $1 ORDER BY ended_at, id",
    [workspaceId],
  );
  return bundles
    .map((b) => ({ ...b, sessions: sessions.filter((s) => s.bundle_id === b.id) }))
    .filter((b) => b.sessions.length > 0);
}
