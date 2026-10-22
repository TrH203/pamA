// Sync (US4). On the receiving server: ingest approved digests from paired devices (Layer 2 runs
// again at ingest) and apply tombstones. On the owner's machine: list what to send and queue
// tombstones when sync is turned off or an approved digest is withdrawn.
import { ulid } from "ulid";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/client.ts";
import { HttpError } from "../http.ts";
import { SessionDigestSchema } from "../schema/digest.ts";
import { assignBundle } from "./bundles.ts";
import { cleanAndLabel, digestHash, storeVersion } from "./digests.ts";
import { upsertProject } from "./projects.ts";

export const SyncDigestSchema = z.strictObject({
  outbox_id: z.string().min(1).max(64),
  digest: z.unknown(),
  approved_at: z.iso.datetime({ offset: true }),
  /** When sync was (last) enabled for the source on the owner's machine. */
  sync_enabled_at: z.iso.datetime({ offset: true }),
  project_name: z.string().min(1).max(200).optional(),
  bundle_name: z.string().min(1).max(200).optional(),
});

export const SyncTombstoneSchema = z.strictObject({
  outbox_id: z.string().min(1).max(64),
  source_type: z.enum(["project", "bundle", "session"]),
  source_key: z.string().min(1).max(600),
});

type SyncDeps = Pick<Deps, "db" | "models" | "rules" | "workspaceId">;

async function receipt(q: Queryable, outboxId: string) {
  const [r] = await q.query<{ result: unknown }>(
    "SELECT result FROM sync_receipts WHERE outbox_id = $1",
    [outboxId],
  );
  return r?.result;
}

async function remember(q: Queryable, outboxId: string, deviceId: string, result: unknown) {
  await q.query(
    "INSERT INTO sync_receipts (outbox_id, device_id, result) VALUES ($1, $2, $3) ON CONFLICT (outbox_id) DO NOTHING",
    [outboxId, deviceId, JSON.stringify(result)],
  );
}

export const bundleKey = (projectKey: string, bundle: string) => `${projectKey}#${bundle}`;
export const sessionKey = (agent: string, id: string) => `${agent}:${id}`;

export async function ingestDigest(
  deps: SyncDeps,
  deviceId: string,
  body: z.infer<typeof SyncDigestSchema>,
) {
  const done = await receipt(deps.db, body.outbox_id);
  if (done) return done as { digest_id: string; version: number };
  const parsed = SessionDigestSchema.safeParse(body.digest);
  if (!parsed.success) throw new HttpError(422, "invalid_digest", parsed.error.message);
  const raw = parsed.data;
  const src = raw.source;
  const bundle = src.bundle_key ?? "default";

  // A tombstone newer than the moment sync was enabled means this delivery is stale.
  const [stale] = await deps.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sync_tombstones WHERE workspace_id = $1 AND received_at > $2
       AND ((source_type = 'project' AND source_key = $3) OR (source_type = 'bundle' AND source_key = $4)
            OR (source_type = 'session' AND source_key = $5))`,
    [
      deps.workspaceId,
      body.sync_enabled_at,
      src.project_key,
      bundleKey(src.project_key, bundle),
      sessionKey(src.agent, src.agent_session_id),
    ],
  );
  if (stale?.n)
    throw new HttpError(
      409,
      "sync_disabled",
      "sync was turned off for this source after this digest was sent",
    );

  const project = await upsertProject(
    deps.db,
    deps.workspaceId,
    src.project_key,
    body.project_name,
  );
  const bundleId = await assignBundle(deps.db, deps.workspaceId, project.id, bundle);
  if (body.bundle_name) {
    await deps.db.query("UPDATE bundles SET name = $2 WHERE id = $1 AND name = key", [
      bundleId,
      body.bundle_name,
    ]);
  }
  const [session] = await deps.db.query<{ id: string; bundle_id: string }>(
    `INSERT INTO sessions (id, workspace_id, project_id, bundle_id, agent, agent_session_id, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, agent, agent_session_id) DO UPDATE SET ended_at = excluded.ended_at
     RETURNING id, bundle_id`,
    [
      ulid(),
      deps.workspaceId,
      project.id,
      bundleId,
      src.agent,
      src.agent_session_id,
      src.started_at ?? null,
      src.ended_at,
    ],
  );
  if (!session) throw new Error("session upsert failed");

  const hash = digestHash(raw);
  const [existing] = await deps.db.query<{ id: string; version: number }>(
    "SELECT id, version FROM digests WHERE session_id = $1 AND digest_hash = $2",
    [session.id, hash],
  );
  let result: { digest_id: string; version: number };
  if (existing) {
    result = { digest_id: existing.id, version: existing.version };
  } else {
    const { digest, labels } = await cleanAndLabel(deps, raw);
    const v = await storeVersion(deps, {
      sessionId: session.id,
      bundleId: session.bundle_id,
      projectId: project.id,
      digest,
      labels,
      status: "approved",
      hash,
    });
    result = { digest_id: v.id, version: v.version };
  }
  await remember(deps.db, body.outbox_id, deviceId, result);
  return result;
}

export async function applyTombstone(
  deps: SyncDeps,
  deviceId: string,
  t: z.infer<typeof SyncTombstoneSchema>,
) {
  const done = await receipt(deps.db, t.outbox_id);
  if (done) return done as { deleted_items: number; degraded_links: number };
  const ws = deps.workspaceId;
  const result = await deps.db.tx(async (q) => {
    await q.query(
      "INSERT INTO sync_tombstones (id, workspace_id, source_type, source_key) VALUES ($1, $2, $3, $4)",
      [ulid(), ws, t.source_type, t.source_key],
    );
    let sessions: { id: string; bundle_id: string; project_id: string }[] = [];
    if (t.source_type === "project") {
      sessions = await q.query(
        "SELECT s.id, s.bundle_id, s.project_id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.workspace_id = $1 AND p.repo_key = $2",
        [ws, t.source_key],
      );
    } else if (t.source_type === "bundle") {
      const i = t.source_key.lastIndexOf("#");
      sessions = await q.query(
        `SELECT s.id, s.bundle_id, s.project_id FROM sessions s JOIN bundles b ON b.id = s.bundle_id JOIN projects p ON p.id = s.project_id
         WHERE s.workspace_id = $1 AND p.repo_key = $2 AND b.key = $3`,
        [ws, t.source_key.slice(0, i), t.source_key.slice(i + 1)],
      );
    } else {
      const i = t.source_key.indexOf(":");
      sessions = await q.query(
        "SELECT id, bundle_id, project_id FROM sessions WHERE workspace_id = $1 AND agent = $2 AND agent_session_id = $3",
        [ws, t.source_key.slice(0, i), t.source_key.slice(i + 1)],
      );
    }
    const ids = sessions.map((s) => s.id);
    const refIds = [...new Set(sessions.flatMap((s) => [s.id, s.bundle_id, s.project_id]))];
    const [links] = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ask_links l WHERE l.workspace_id = $1 AND l.revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.source_refs) r WHERE r->>'id' = ANY($2))`,
      [ws, refIds],
    );
    const deleted = await q.query(
      "DELETE FROM digest_items WHERE session_id = ANY($1) RETURNING id",
      [ids],
    );
    await q.query("DELETE FROM digests WHERE session_id = ANY($1)", [ids]);
    await q.query("DELETE FROM sessions WHERE id = ANY($1)", [ids]);
    // Remove containers left empty, so links over them stop resolving.
    await q.query(
      "DELETE FROM bundles b WHERE b.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.bundle_id = b.id)",
      [sessions.map((s) => s.bundle_id)],
    );
    if (t.source_type === "project") {
      await q.query("DELETE FROM projects WHERE workspace_id = $1 AND repo_key = $2", [
        ws,
        t.source_key,
      ]);
    }
    return { deleted_items: deleted.length, degraded_links: links?.n ?? 0 };
  });
  await remember(deps.db, t.outbox_id, deviceId, result);
  return result;
}

// --- Owner's machine -------------------------------------------------------------------------

/** Queue a tombstone for a source whose sync is turned off (or whose digest is withdrawn). */
export async function queueTombstone(
  q: Queryable,
  target: string,
  type: "project" | "bundle" | "session",
  key: string,
) {
  await q.query(
    `INSERT INTO sync_outgoing (id, target, source_type, source_key) VALUES ($1, $2, $3, $4)
     ON CONFLICT (target, source_type, source_key) WHERE handed_at IS NULL DO NOTHING`,
    [ulid(), target, type, key],
  );
}

/** Forget deliveries for a source so that re-enabling sync sends everything again. */
export async function resetDeliveries(q: Queryable, sessionFilter: string, param: string) {
  await q.query(
    `DELETE FROM sync_deliveries x USING digests d, sessions s
     WHERE x.digest_id = d.id AND d.session_id = s.id AND ${sessionFilter}`,
    [param],
  );
}

export async function pending(deps: Pick<Deps, "db" | "workspaceId">) {
  const digests = await deps.db.query<{
    digest_id: string;
    target: string;
    digest: unknown;
    approved_at: Date;
    sync_enabled_at: Date | null;
    project_name: string;
    bundle_name: string;
  }>(
    `SELECT d.id AS digest_id, p.sync_target AS target, d.content AS digest, d.approved_at,
            CASE WHEN b.sync_enabled IS NOT NULL THEN b.sync_enabled_at ELSE p.sync_enabled_at END AS sync_enabled_at,
            p.name AS project_name, b.name AS bundle_name
     FROM digests d JOIN sessions s ON s.id = d.session_id
     JOIN projects p ON p.id = s.project_id JOIN bundles b ON b.id = s.bundle_id
     WHERE d.workspace_id = $1 AND d.status = 'approved' AND COALESCE(b.sync_enabled, p.sync_enabled)
       AND p.sync_target IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sync_deliveries x WHERE x.digest_id = d.id AND x.target = p.sync_target)
     ORDER BY d.approved_at, d.id LIMIT 500`,
    [deps.workspaceId],
  );
  const tombstones = await deps.db.query<{
    id: string;
    target: string;
    source_type: string;
    source_key: string;
  }>(
    "SELECT id, target, source_type, source_key FROM sync_outgoing WHERE handed_at IS NULL ORDER BY created_at, id",
  );
  return { digests, tombstones };
}

export async function ack(
  deps: Pick<Deps, "db">,
  a: { digests: { digest_id: string; target: string }[]; tombstones: string[] },
) {
  await deps.db.tx(async (q) => {
    for (const d of a.digests) {
      await q.query(
        "INSERT INTO sync_deliveries (digest_id, target) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [d.digest_id, d.target],
      );
    }
    if (a.tombstones.length) {
      await q.query("UPDATE sync_outgoing SET handed_at = now() WHERE id = ANY($1)", [
        a.tombstones,
      ]);
    }
  });
}

/** Turn a project's sync on or off (FR-024/025). Off queues a tombstone for every replica. */
export async function setProjectSync(
  deps: Pick<Deps, "db" | "workspaceId">,
  id: string,
  enabled: boolean,
  target?: string | null,
) {
  await deps.db.tx(async (q) => {
    const [p] = await q.query<{
      repo_key: string;
      sync_enabled: boolean;
      sync_target: string | null;
    }>(
      "SELECT repo_key, sync_enabled, sync_target FROM projects WHERE id = $1 AND workspace_id = $2",
      [id, deps.workspaceId],
    );
    if (!p) throw new HttpError(404, "not_found", "project not found");
    const newTarget = target === undefined ? p.sync_target : target;
    if (enabled) {
      if (!newTarget)
        throw new HttpError(422, "invalid_request", "sync needs a target server (sync_target)");
      await q.query(
        `UPDATE projects SET sync_enabled = true, sync_target = $2,
           sync_enabled_at = CASE WHEN sync_enabled THEN sync_enabled_at ELSE now() END WHERE id = $1`,
        [id, newTarget],
      );
      return;
    }
    if (p.sync_enabled && p.sync_target) {
      await queueTombstone(q, p.sync_target, "project", p.repo_key);
      await resetDeliveries(q, "s.project_id = $1", id);
    }
    await q.query("UPDATE projects SET sync_enabled = false WHERE id = $1", [id]);
  });
}

/** Bundle override: true/false, or null to inherit the project setting. */
export async function setBundleSync(
  deps: Pick<Deps, "db" | "workspaceId">,
  id: string,
  enabled: boolean | null,
  target?: string | null,
) {
  await deps.db.tx(async (q) => {
    const [b] = await q.query<{
      key: string | null;
      name: string;
      sync_enabled: boolean | null;
      project_id: string;
      repo_key: string;
      p_enabled: boolean;
      sync_target: string | null;
    }>(
      `SELECT b.key, b.name, b.sync_enabled, b.project_id, p.repo_key, p.sync_enabled AS p_enabled, p.sync_target
       FROM bundles b JOIN projects p ON p.id = b.project_id WHERE b.id = $1 AND b.workspace_id = $2`,
      [id, deps.workspaceId],
    );
    if (!b) throw new HttpError(404, "not_found", "bundle not found");
    const was = b.sync_enabled ?? b.p_enabled;
    const now = enabled ?? b.p_enabled;
    let syncTarget = b.sync_target;
    if (target) {
      await q.query("UPDATE projects SET sync_target = $2 WHERE id = $1", [b.project_id, target]);
      syncTarget = target;
    }
    if (now && !syncTarget)
      throw new HttpError(422, "invalid_request", "sync needs a target server (sync_target)");
    await q.query(
      `UPDATE bundles SET sync_enabled = $2,
         sync_enabled_at = CASE WHEN $3::boolean THEN now() ELSE sync_enabled_at END WHERE id = $1`,
      [id, enabled, Boolean(now && !was)],
    );
    if (was && !now && syncTarget) {
      await queueTombstone(q, syncTarget, "bundle", bundleKey(b.repo_key, b.key ?? b.name));
      await resetDeliveries(q, "s.bundle_id = $1", id);
    }
  });
}
