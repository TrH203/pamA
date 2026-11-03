// Library (spec 007, plan 6.3): what the owner has captured, as Project → Task (bundle) → agent
// session → digest versions, plus owner-wide search. Owner routes only; every query is limited to
// the caller's workspace.
import type { Deps } from "../app.ts";
import { HttpError } from "../http.ts";
import { embedTexts } from "../pipeline/embed.ts";
import { scopedItems } from "../policy/scoped-repo.ts";
import { affectedLinksFor, queueTombstone, sessionKey } from "./sync.ts";

type LibDeps = Pick<Deps, "db" | "workspaceId">;

export const SESSION_STATUSES = ["draft", "approved", "discarded", "withdrawn", "none"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const DIGEST_STATUSES = [
  "draft",
  "approved",
  "discarded",
  "withdrawn",
  "superseded",
] as const;

export interface Page {
  limit: number;
  offset: number;
}

/** `limit` 1..200 (default 50) and `offset` ≥ 0 from query strings. */
export function page(q: { limit?: string | undefined; offset?: string | undefined }): Page {
  const n = (v: string | undefined, d: number) => {
    const x = Number.parseInt(v ?? "", 10);
    return Number.isFinite(x) ? x : d;
  };
  return {
    limit: Math.min(200, Math.max(1, n(q.limit, 50))),
    offset: Math.max(0, n(q.offset, 0)),
  };
}

// A session's status is the status of its newest non-superseded digest version.
const LATEST = `(SELECT d.status FROM digests d WHERE d.session_id = s.id AND d.status <> 'superseded'
                 ORDER BY d.version DESC LIMIT 1)`;

export interface SessionFilter {
  project?: string | undefined;
  bundle?: string | undefined;
  agent?: string | undefined;
  status?: SessionStatus | undefined;
}

export async function listSessions(deps: LibDeps, f: SessionFilter, p: Page) {
  const where = ["s.workspace_id = $1"];
  const args: unknown[] = [deps.workspaceId];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace("?", `$${args.length}`));
  };
  if (f.project) add("s.project_id = ?", f.project);
  if (f.bundle) add("s.bundle_id = ?", f.bundle);
  if (f.agent) add("s.agent = ?", f.agent);
  if (f.status === "none") where.push(`${LATEST} IS NULL`);
  else if (f.status) add(`${LATEST} = ?`, f.status);
  const filter = where.join(" AND ");
  const [{ total } = { total: 0 }] = await deps.db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM sessions s WHERE ${filter}`,
    args,
  );
  const items = await deps.db.query(
    `SELECT s.id, s.agent, s.agent_session_id, s.started_at, s.ended_at, s.bundle_pinned,
            p.id AS project_id, p.name AS project, b.id AS bundle_id, b.name AS bundle,
            ${LATEST} AS status,
            (SELECT d.content->>'goal' FROM digests d WHERE d.session_id = s.id AND d.status <> 'superseded'
             ORDER BY d.version DESC LIMIT 1) AS goal,
            (SELECT count(*)::int FROM digests d WHERE d.session_id = s.id) AS versions,
            COALESCE((SELECT json_agg(sb.name ORDER BY sb.position) FROM session_branches sb
                      WHERE sb.session_id = s.id), '[]'::json) AS branches
     FROM sessions s JOIN projects p ON p.id = s.project_id JOIN bundles b ON b.id = s.bundle_id
     WHERE ${filter}
     ORDER BY s.ended_at DESC NULLS LAST, s.id DESC
     LIMIT ${p.limit} OFFSET ${p.offset}`,
    args,
  );
  return {
    items,
    total,
    limit: p.limit,
    offset: p.offset,
    next_offset: p.offset + items.length < total ? p.offset + items.length : null,
  };
}

export async function getSession(deps: LibDeps, id: string) {
  const [s] = await deps.db.query<{
    id: string;
    agent: string;
    agent_session_id: string;
    project_id: string;
    bundle_id: string;
    [k: string]: unknown;
  }>(
    `SELECT s.id, s.agent, s.agent_session_id, s.started_at, s.ended_at, s.bundle_pinned,
            s.redaction_counts, s.created_at,
            p.id AS project_id, p.name AS project, p.repo_key AS project_key,
            b.id AS bundle_id, b.name AS bundle, ${LATEST} AS status
     FROM sessions s JOIN projects p ON p.id = s.project_id JOIN bundles b ON b.id = s.bundle_id
     WHERE s.id = $1 AND s.workspace_id = $2`,
    [id, deps.workspaceId],
  );
  if (!s) throw new HttpError(404, "not_found", "session not found");
  const branches = await deps.db.query(
    `SELECT name, first_seen_at, last_seen_at, event_count FROM session_branches
     WHERE session_id = $1 ORDER BY position`,
    [id],
  );
  const digests = await deps.db.query(
    `SELECT d.id, d.version, d.status, d.created_at, d.approved_at, d.model, d.prompt_version,
            d.content->>'goal' AS goal, dv.name AS device
     FROM digests d LEFT JOIN devices dv ON dv.id = d.origin_device_id
     WHERE d.session_id = $1 ORDER BY d.version DESC`,
    [id],
  );
  const links = await deps.db.query(
    `SELECT slug, title, expires_at FROM ask_links
     WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > now()
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(source_refs) r WHERE r->>'id' = ANY($2))
     ORDER BY created_at`,
    [deps.workspaceId, [s.id, s.bundle_id, s.project_id]],
  );
  // The server does not see the device's capture pipeline; `pama sessions show` adds it locally.
  return { ...s, branches, digests, links, capture: null };
}

export interface DigestFilter {
  status?: (typeof DIGEST_STATUSES)[number] | undefined;
  project?: string | undefined;
  bundle?: string | undefined;
}

/** Digest versions; without a status filter superseded versions are left out. */
export async function listDigests(deps: LibDeps, f: DigestFilter, p: Page) {
  const where = ["d.workspace_id = $1"];
  const args: unknown[] = [deps.workspaceId];
  if (f.status) {
    args.push(f.status);
    where.push(`d.status = $${args.length}`);
  } else where.push("d.status <> 'superseded'");
  if (f.project) {
    args.push(f.project);
    where.push(`s.project_id = $${args.length}`);
  }
  if (f.bundle) {
    args.push(f.bundle);
    where.push(`s.bundle_id = $${args.length}`);
  }
  const filter = where.join(" AND ");
  const from = "FROM digests d JOIN sessions s ON s.id = d.session_id";
  const [{ total } = { total: 0 }] = await deps.db.query<{ total: number }>(
    `SELECT count(*)::int AS total ${from} WHERE ${filter}`,
    args,
  );
  const items = await deps.db.query(
    `SELECT d.id, d.session_id, d.version, d.status, d.created_at, d.approved_at,
            d.content->>'goal' AS goal,
            jsonb_array_length(COALESCE(d.content->'decisions', '[]'::jsonb)) AS decisions,
            s.agent, s.agent_session_id,
            p.id AS project_id, p.name AS project, b.id AS bundle_id, b.name AS bundle
     ${from} JOIN projects p ON p.id = s.project_id JOIN bundles b ON b.id = s.bundle_id
     WHERE ${filter}
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT ${p.limit} OFFSET ${p.offset}`,
    args,
  );
  return {
    items,
    total,
    limit: p.limit,
    offset: p.offset,
    next_offset: p.offset + items.length < total ? p.offset + items.length : null,
  };
}

/**
 * Owner-wide hybrid search (full-text + vector, reciprocal rank fusion) over the active items of
 * approved digests, through the same scoped retrieval as answers (the scope is every session of
 * the workspace, no label denied). Embedding failures fall back to full-text only.
 */
export async function searchLibrary(
  deps: Pick<Deps, "db" | "workspaceId" | "models">,
  text: string,
  limit = 20,
) {
  const q = text.trim();
  if (!q) throw new HttpError(422, "invalid_request", "q is required");
  const sessions = await deps.db.query<{ id: string }>(
    "SELECT id FROM sessions WHERE workspace_id = $1",
    [deps.workspaceId],
  );
  let embedding: number[] | undefined;
  let mode: "hybrid" | "text" = "text";
  try {
    [embedding] = await embedTexts(deps.models.embed, [q]);
    if (embedding) mode = "hybrid";
  } catch {
    embedding = undefined;
  }
  const items = await scopedItems(
    deps.db,
    { workspaceId: deps.workspaceId, sessionIds: sessions.map((s) => s.id), denyLabels: [] },
    { text: q, k: Math.min(50, Math.max(1, limit)), ...(embedding ? { embedding } : {}) },
  );
  const refs = items.length
    ? await deps.db.query<{ id: string; project_id: string; project: string }>(
        "SELECT s.id, p.id AS project_id, p.name AS project FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ANY($1)",
        [[...new Set(items.map((i) => i.session_id))]],
      )
    : [];
  const bySession = new Map(refs.map((r) => [r.id, r]));
  return {
    mode,
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      text: i.text,
      rationale: i.rationale,
      labels: i.labels,
      score: i.score,
      digest_id: i.digest_id,
      digest_version: i.digest_version,
      session_id: i.session_id,
      bundle_id: i.bundle_id,
      bundle: i.bundle,
      project_id: bySession.get(i.session_id)?.project_id ?? null,
      project: bySession.get(i.session_id)?.project ?? null,
      ended_at: i.ended_at,
    })),
  };
}

/**
 * The owner deletes a session with all its digest versions. If its task or project is published
 * (local mode) a session tombstone is queued so the copy on the target goes too; links that lose
 * sources here are reported. Empty tasks are removed.
 */
export async function deleteSession(deps: LibDeps, id: string) {
  return deps.db.tx(async (q) => {
    const [s] = await q.query<{
      id: string;
      agent: string;
      agent_session_id: string;
      bundle_id: string;
      project_id: string;
      target: string | null;
      published: boolean;
    }>(
      `SELECT s.id, s.agent, s.agent_session_id, s.bundle_id, s.project_id, p.sync_target AS target,
              COALESCE(b.sync_enabled, p.sync_enabled) AS published
       FROM sessions s JOIN projects p ON p.id = s.project_id JOIN bundles b ON b.id = s.bundle_id
       WHERE s.id = $1 AND s.workspace_id = $2`,
      [id, deps.workspaceId],
    );
    if (!s) throw new HttpError(404, "not_found", "session not found");
    const links = await affectedLinksFor(q, deps.workspaceId, [s], { project: false });
    const tombstone = Boolean(s.published && s.target);
    if (tombstone && s.target) {
      await queueTombstone(q, s.target, "session", sessionKey(s.agent, s.agent_session_id));
    }
    const digests = await q.query<{ id: string }>(
      "DELETE FROM digests WHERE session_id = $1 RETURNING id",
      [id],
    );
    await q.query("DELETE FROM sync_deliveries WHERE digest_id = ANY($1)", [
      digests.map((d) => d.id),
    ]);
    await q.query("DELETE FROM sessions WHERE id = $1", [id]);
    await q.query(
      "DELETE FROM bundles b WHERE b.id = $1 AND NOT EXISTS (SELECT 1 FROM sessions x WHERE x.bundle_id = b.id)",
      [s.bundle_id],
    );
    return { deleted: id, digests: digests.length, tombstone, links };
  });
}
