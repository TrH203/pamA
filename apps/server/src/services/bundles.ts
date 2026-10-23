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

const NAME_MAX = 60;

/** A short, readable bundle name from a digest goal: first line, ≤ 60 chars at a word boundary. */
export function suggestName(goal: string): string | null {
  const line = goal.split(/\r?\n/).find((l) => l.trim()) ?? "";
  let name = line.replace(/\s+/g, " ").trim();
  if (name.length > NAME_MAX) {
    const head = name.slice(0, NAME_MAX + 1);
    const space = head.lastIndexOf(" ");
    name = space > 0 ? head.slice(0, space) : name.slice(0, NAME_MAX);
  }
  name = name.replace(/[\s.,;:!?-]+$/, "");
  return name || null;
}

/** Replace the key-named fallback by a name from the first approved digest; owner names stay. */
export async function applySuggestedName(q: Queryable, bundleId: string, goal: string) {
  const name = suggestName(goal);
  if (!name) return;
  await q.query(
    `UPDATE bundles SET name = $2, name_source = 'suggested', name_updated_at = now()
     WHERE id = $1 AND name_source = 'key'`,
    [bundleId, name],
  );
}

export interface BranchInput {
  name: string;
  first_seen?: string | undefined;
  last_seen?: string | undefined;
  events?: number | undefined;
}

/** The branch list of a digest/transcript; a lone `git.branch` counts as a one-entry list. */
export function branchList(git?: {
  branch?: string | undefined;
  branches?: BranchInput[] | undefined;
}) {
  if (git?.branches?.length) return git.branches;
  return git?.branch ? [{ name: git.branch }] : [];
}

/** Replace the session's recorded branches, keeping the given (first-seen) order. */
export async function recordBranches(
  q: Queryable,
  workspaceId: string,
  sessionId: string,
  branches: BranchInput[],
) {
  await q.query("DELETE FROM session_branches WHERE session_id = $1", [sessionId]);
  for (const [i, b] of branches.entries()) {
    await q.query(
      `INSERT INTO session_branches (session_id, workspace_id, name, position, first_seen_at, last_seen_at, event_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [sessionId, workspaceId, b.name, i, b.first_seen ?? null, b.last_seen ?? null, b.events ?? 0],
    );
  }
}

/**
 * Re-file an unpinned session under `key` (re-capture after the filing branch changed). Sessions the
 * owner moved (split/merge) stay where they are. Returns the session's bundle id afterwards.
 */
export async function reevaluateSession(
  q: Queryable,
  workspaceId: string,
  projectId: string,
  sessionId: string,
  key: string,
): Promise<string> {
  const [s] = await q.query<{ bundle_id: string; bundle_pinned: boolean }>(
    "SELECT bundle_id, bundle_pinned FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!s) throw new HttpError(404, "not_found", "session not found");
  if (s.bundle_pinned) return s.bundle_id;
  const bundleId = await assignBundle(q, workspaceId, projectId, key);
  if (bundleId !== s.bundle_id) await moveSessions(q, [sessionId], bundleId, false);
  return bundleId;
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
  await db.query(
    "UPDATE bundles SET name = $2, name_source = 'owner', name_updated_at = now() WHERE id = $1",
    [id, name],
  );
}

/** `pin` marks the sessions as owner-placed so re-capture does not re-file them. */
async function moveSessions(q: Queryable, sessionIds: string[], bundleId: string, pin = true) {
  await q.query(
    "UPDATE sessions SET bundle_id = $2, bundle_pinned = bundle_pinned OR $3 WHERE id = ANY($1)",
    [sessionIds, bundleId, pin],
  );
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
      "INSERT INTO bundles (id, workspace_id, project_id, name, name_source, name_updated_at, key, sync_enabled) SELECT $1, workspace_id, project_id, $2, 'owner', now(), NULL, sync_enabled FROM bundles WHERE id = $3",
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
    await q.query(
      "UPDATE bundles SET name = $2, name_source = 'owner', name_updated_at = now() WHERE id = $1",
      [target, name],
    );
    return target;
  });
}

export interface BundleSummary {
  id: string;
  name: string;
  name_source: "key" | "suggested" | "owner";
  key: string | null;
  project_id: string;
  project: string;
  /** Distinct branches over the member sessions, earliest first-seen first. */
  branches: string[];
  session_count: number;
  /** Latest `ended_at` of the member sessions. */
  last_activity: Date | null;
  sessions: {
    id: string;
    agent: string;
    agent_session_id: string;
    ended_at: Date | null;
    branches: string[];
    bundle_pinned: boolean;
  }[];
}

/** Bundles with their derived summary: three queries however many bundles there are (research R4). */
export async function listBundles(db: Db, workspaceId: string): Promise<BundleSummary[]> {
  const bundles = await db.query<{
    id: string;
    name: string;
    name_source: BundleSummary["name_source"];
    key: string | null;
    project_id: string;
    project: string;
  }>(
    `SELECT b.id, b.name, b.name_source, b.key, b.project_id, p.name AS project
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
    bundle_pinned: boolean;
  }>(
    "SELECT id, bundle_id, agent, agent_session_id, ended_at, bundle_pinned FROM sessions WHERE workspace_id = $1 ORDER BY ended_at, id",
    [workspaceId],
  );
  const rows = await db.query<{
    session_id: string;
    name: string;
    position: number;
    first_seen_at: Date | null;
  }>(
    "SELECT session_id, name, position, first_seen_at FROM session_branches WHERE workspace_id = $1 ORDER BY position",
    [workspaceId],
  );
  const bySession = new Map<string, typeof rows>();
  for (const r of rows) bySession.set(r.session_id, [...(bySession.get(r.session_id) ?? []), r]);

  return bundles
    .map((b) => {
      const own = sessions.filter((s) => s.bundle_id === b.id);
      const first = new Map<string, { at: number; pos: number }>();
      for (const s of own) {
        for (const r of bySession.get(s.id) ?? []) {
          const at = r.first_seen_at
            ? new Date(r.first_seen_at).getTime()
            : Number.POSITIVE_INFINITY;
          const seen = first.get(r.name);
          if (!seen || at < seen.at) first.set(r.name, { at, pos: r.position });
        }
      }
      const branches = [...first.entries()]
        .sort(([an, a], [bn, b]) => a.at - b.at || a.pos - b.pos || an.localeCompare(bn))
        .map(([name]) => name);
      const ended = own.flatMap((s) => (s.ended_at ? [new Date(s.ended_at)] : []));
      return {
        ...b,
        branches,
        session_count: own.length,
        last_activity: ended.length ? new Date(Math.max(...ended.map((d) => d.getTime()))) : null,
        sessions: own.map((s) => ({
          id: s.id,
          agent: s.agent,
          agent_session_id: s.agent_session_id,
          ended_at: s.ended_at,
          branches: (bySession.get(s.id) ?? []).map((r) => r.name),
          bundle_pinned: s.bundle_pinned,
        })),
      };
    })
    .filter((b) => b.sessions.length > 0);
}
