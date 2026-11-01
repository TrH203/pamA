// Sync (US4). On the receiving server: ingest approved digests from paired devices (Layer 2 runs
// again at ingest) and apply tombstones. On the owner's machine: list what to send and queue
// tombstones when sync is turned off or an approved digest is withdrawn.
import { ulid } from "ulid";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/client.ts";
import { HttpError } from "../http.ts";
import { completeDigest, type ResumeState } from "../pipeline/complete.ts";
import { SessionDigestSchema } from "../schema/digest.ts";
import {
  applySuggestedName,
  assignBundle,
  branchList,
  moveSessions,
  recordBranches,
  reevaluateSession,
} from "./bundles.ts";
import { approveDigest, cleanAndLabel, digestHash, storeVersion } from "./digests.ts";
import { autoApproveFor, upsertProject } from "./projects.ts";
import type { RunTracker } from "./runs.ts";

export const SyncDigestSchema = z.strictObject({
  outbox_id: z.string().min(1).max(64),
  digest: z.unknown(),
  approved_at: z.iso.datetime({ offset: true }),
  /** When sync was (last) enabled for the source on the owner's machine. */
  sync_enabled_at: z.iso.datetime({ offset: true }),
  project_name: z.string().min(1).max(200).optional(),
  bundle_name: z.string().min(1).max(200).optional(),
  bundle_name_source: z.enum(["key", "suggested", "owner"]).optional(),
  /**
   * The owner's portable task key (`bundleRef`): where the session is filed on the owner's
   * machine, which differs from `source.bundle_key` after a split or merge. Sent to servers that
   * advertise `bundle_refs`; older devices leave it out and the branch key is used.
   */
  bundle_ref: z.string().min(1).max(300).optional(),
});

/** A draft from a thin-client device (spec 004): reviewed on the server, auto-approve applies. */
export const SyncDraftSchema = SyncDigestSchema.omit({ approved_at: true });

export const SyncTombstoneSchema = z.strictObject({
  outbox_id: z.string().min(1).max(64),
  source_type: z.enum(["project", "bundle", "session"]),
  source_key: z.string().min(1).max(600),
});

const SessionRefSchema = z.strictObject({
  agent: z.string().min(1).max(40),
  agent_session_id: z.string().min(1).max(300),
});

/**
 * A task (bundle) change made on the owner's machine (spec 007): rename, split or merge, sent as
 * the task's resulting state. `bundle_ref` is the portable task key: the bundle key for tasks
 * filed by branch, `id:<local bundle id>` for tasks the owner made by splitting.
 */
export const SyncBundleChangeSchema = z.strictObject({
  outbox_id: z.string().min(1).max(64),
  project_key: z.string().min(1).max(600),
  bundle_ref: z.string().min(1).max(300),
  name: z.string().min(1).max(200),
  name_source: z.enum(["key", "suggested", "owner"]),
  sessions: z.array(SessionRefSchema).max(2000),
});

/** The portable key of a local bundle (tombstones and task changes use the same one). */
export const bundleRef = (b: { id: string; key: string | null }) => b.key ?? `id:${b.id}`;

type SyncDeps = Pick<Deps, "db" | "models" | "rules" | "workspaceId">;

async function receipt(q: Queryable, outboxId: string) {
  const [r] = await q.query<{ result: unknown }>(
    "SELECT result FROM sync_receipts WHERE outbox_id = $1",
    [outboxId],
  );
  return r?.result;
}

export async function remember(q: Queryable, outboxId: string, deviceId: string, result: unknown) {
  await q.query(
    "INSERT INTO sync_receipts (outbox_id, device_id, result) VALUES ($1, $2, $3) ON CONFLICT (outbox_id) DO NOTHING",
    [outboxId, deviceId, JSON.stringify(result)],
  );
}

export const bundleKey = (projectKey: string, bundle: string) => `${projectKey}#${bundle}`;
export const sessionKey = (agent: string, id: string) => `${agent}:${id}`;

type Ingested = { digest_id: string; version: number; status?: "draft" | "approved" };

export async function ingestDigest(
  deps: SyncDeps,
  deviceId: string,
  body: z.infer<typeof SyncDraftSchema>,
  status: "approved" | "draft" = "approved",
  run?: RunTracker,
): Promise<Ingested> {
  const done = await receipt(deps.db, body.outbox_id);
  if (done) return done as Ingested;
  const parsed = SessionDigestSchema.safeParse(body.digest);
  if (!parsed.success) throw new HttpError(422, "invalid_digest", parsed.error.message);
  const raw = parsed.data;
  const src = raw.source;
  // The owner's task wins over the filing branch: after a split or merge they differ, and names
  // and placement must follow the task the owner sees (spec 007).
  const bundle = body.bundle_ref ?? src.bundle_key ?? "default";

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
  if (body.bundle_name && status === "draft") {
    // Thin-client drafts carry a name suggested on the device from the goal; like names suggested
    // on the server it only replaces the key fallback (the first suggestion wins).
    if ((body.bundle_name_source ?? "key") === "suggested")
      await applySuggestedName(deps.db, bundleId, body.bundle_name);
  } else if (body.bundle_name) {
    // The device is the source of truth: its owner name always wins, its suggestion wins unless
    // the replica owner renamed the bundle, and a legacy name only replaces the key fallback.
    const source = body.bundle_name_source ?? "key";
    await deps.db.query(
      `UPDATE bundles SET name = $2, name_source = $3, name_updated_at = now()
       WHERE id = $1 AND name <> $2 AND (
         $3 = 'owner' OR (name_source <> 'owner' AND ($3 = 'suggested' OR name_source = 'key')))`,
      [bundleId, body.bundle_name, source],
    );
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
  // Same rules as the local pipeline: record the branches, re-file an unpinned session.
  await recordBranches(deps.db, deps.workspaceId, session.id, branchList(src.git));
  session.bundle_id = await reevaluateSession(
    deps.db,
    deps.workspaceId,
    project.id,
    session.id,
    bundle,
  );

  const hash = digestHash(raw);
  const [existing] = await deps.db.query<{ id: string; version: number; status: string }>(
    "SELECT id, version, status FROM digests WHERE session_id = $1 AND digest_hash = $2",
    [session.id, hash],
  );
  let result: Ingested;
  if (existing) {
    result = { digest_id: existing.id, version: existing.version };
    if (status === "draft") {
      result.status = existing.status === "approved" ? "approved" : "draft";
    }
  } else if (status === "draft") {
    // Thin client (spec 004): the device drafted it; the run records the server's stages.
    await run?.stage("drafted");
    const { digest, labels } = await cleanAndLabel(deps, raw);
    const state: ResumeState = {
      input_hash: hash,
      session_id: session.id,
      bundle_id: session.bundle_id,
      project_id: project.id,
      digest,
      labels,
      content_hash: hash,
      origin_device_id: deviceId,
      outbox_id: body.outbox_id,
    };
    await run?.stage("classified", state);
    return completeDigest(deps, state, run);
  } else {
    const { digest, labels } = await cleanAndLabel(deps, raw);
    const v = await storeVersion(deps, {
      sessionId: session.id,
      bundleId: session.bundle_id,
      projectId: project.id,
      digest,
      labels,
      status,
      hash,
    });
    result = { digest_id: v.id, version: v.version };
  }
  await remember(deps.db, body.outbox_id, deviceId, result);
  return result;
}

type SourceSession = { id: string; bundle_id: string; project_id: string };

/** The sessions a portable source key covers in a workspace (tombstones, affected links). */
export async function sessionsForSource(
  q: Queryable,
  ws: string,
  type: "project" | "bundle" | "session",
  key: string,
): Promise<SourceSession[]> {
  if (type === "project") {
    return q.query(
      "SELECT s.id, s.bundle_id, s.project_id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.workspace_id = $1 AND p.repo_key = $2",
      [ws, key],
    );
  }
  if (type === "bundle") {
    const i = key.lastIndexOf("#");
    return q.query(
      `SELECT s.id, s.bundle_id, s.project_id FROM sessions s JOIN bundles b ON b.id = s.bundle_id JOIN projects p ON p.id = s.project_id
       WHERE s.workspace_id = $1 AND p.repo_key = $2 AND b.key = $3`,
      [ws, key.slice(0, i), key.slice(i + 1)],
    );
  }
  const i = key.indexOf(":");
  return q.query(
    "SELECT id, bundle_id, project_id FROM sessions WHERE workspace_id = $1 AND agent = $2 AND agent_session_id = $3",
    [ws, key.slice(0, i), key.slice(i + 1)],
  );
}

export interface AffectedLink {
  slug: string;
  title: string;
  expires_at: Date;
  /** The link's sources that would disappear. */
  lost: { type: string; id: string }[];
  /** True when nothing would be left in the link's scope (it stops answering). */
  empty: boolean;
}

/**
 * Ask Links on this server whose scope would lose sources if `type`/`key` were deleted (sync
 * turned off): asked by the device before it sends the tombstone (spec 007).
 */
export async function affectedLinks(
  deps: Pick<Deps, "db" | "workspaceId">,
  type: "project" | "bundle" | "session",
  key: string,
): Promise<AffectedLink[]> {
  const ws = deps.workspaceId;
  return affectedLinksFor(deps.db, ws, await sessionsForSource(deps.db, ws, type, key), {
    project: type === "project",
  });
}

/** Links losing sources when `sessions` are deleted (with their projects too when `project`). */
export async function affectedLinksFor(
  q: Queryable,
  ws: string,
  sessions: SourceSession[],
  opts: { project: boolean },
): Promise<AffectedLink[]> {
  if (!sessions.length) return [];
  const gone = new Set(sessions.map((s) => s.id));
  const bundleIds = [...new Set(sessions.map((s) => s.bundle_id))];
  // Bundles with no session left after the deletion disappear too.
  const left = await q.query<{ bundle_id: string }>(
    "SELECT DISTINCT bundle_id FROM sessions WHERE bundle_id = ANY($1) AND NOT (id = ANY($2))",
    [bundleIds, sessions.map((s) => s.id)],
  );
  const kept = new Set(left.map((r) => r.bundle_id));
  for (const b of bundleIds) if (!kept.has(b)) gone.add(b);
  if (opts.project) for (const s of sessions) gone.add(s.project_id);
  const links = await q.query<{
    slug: string;
    title: string;
    expires_at: Date;
    source_refs: { type: string; id: string }[];
  }>(
    `SELECT slug, title, expires_at, source_refs FROM ask_links
     WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > now()
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(source_refs) r WHERE r->>'id' = ANY($2))
     ORDER BY created_at, slug`,
    [ws, [...gone]],
  );
  return links.map((l) => {
    const lost = l.source_refs.filter((r) => gone.has(r.id));
    return {
      slug: l.slug,
      title: l.title,
      expires_at: l.expires_at,
      lost,
      empty: lost.length === l.source_refs.length,
    };
  });
}

/**
 * Receiving server: apply a task change from the owner's machine. Only sessions this server
 * already has are moved (and pinned, so later deliveries do not re-file them); tasks left empty
 * are removed. Idempotent by outbox id.
 */
export async function applyBundleChange(
  deps: SyncDeps,
  deviceId: string,
  ch: z.infer<typeof SyncBundleChangeSchema>,
) {
  const done = await receipt(deps.db, ch.outbox_id);
  if (done) return done as { bundle_id: string | null; moved: number };
  const ws = deps.workspaceId;
  const result = await deps.db.tx(async (q) => {
    const [project] = await q.query<{ id: string }>(
      "SELECT id FROM projects WHERE workspace_id = $1 AND repo_key = $2",
      [ws, ch.project_key],
    );
    if (!project) return { bundle_id: null, moved: 0 };
    const all = await q.query<{ id: string; bundle_id: string; agent: string; sid: string }>(
      `SELECT id, bundle_id, agent, agent_session_id AS sid FROM sessions
       WHERE workspace_id = $1 AND project_id = $2 AND agent_session_id = ANY($3)`,
      [ws, project.id, ch.sessions.map((x) => x.agent_session_id)],
    );
    const wanted = new Set(ch.sessions.map((x) => `${x.agent}:${x.agent_session_id}`));
    const sessions = all.filter((x) => wanted.has(`${x.agent}:${x.sid}`));
    const [existing] = await q.query<{ id: string }>(
      "SELECT id FROM bundles WHERE project_id = $1 AND key = $2",
      [project.id, ch.bundle_ref],
    );
    // Nothing published in this task yet: do not create an empty one.
    if (!existing && !sessions.length) return { bundle_id: null, moved: 0 };
    const bundleId = existing?.id ?? (await assignBundle(q, ws, project.id, ch.bundle_ref));
    // Same precedence as names on digests: owner names always win, a suggestion wins unless the
    // replica owner renamed the task, a key name only replaces the key fallback.
    await q.query(
      `UPDATE bundles SET name = $2, name_source = $3, name_updated_at = now()
       WHERE id = $1 AND name <> $2 AND (
         $3 = 'owner' OR (name_source <> 'owner' AND ($3 = 'suggested' OR name_source = 'key')))`,
      [bundleId, ch.name, ch.name_source],
    );
    const moving = sessions.filter((x) => x.bundle_id !== bundleId);
    if (moving.length) {
      await moveSessions(
        q,
        moving.map((x) => x.id),
        bundleId,
      );
    }
    await q.query(
      "DELETE FROM bundles b WHERE b.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.bundle_id = b.id)",
      [[...new Set(moving.map((x) => x.bundle_id))]],
    );
    return { bundle_id: bundleId, moved: moving.length };
  });
  await remember(deps.db, ch.outbox_id, deviceId, result);
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
    const sessions = await sessionsForSource(q, ws, t.source_type, t.source_key);
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

/**
 * Review decisions in the device's workspace after `since` (spec 004, FR-025): the device keeps
 * every draft and applies these to its own copies. The cursor is the digests' review sequence.
 */
export async function changesSince(
  deps: Pick<Deps, "db" | "workspaceId">,
  since: string | undefined,
) {
  const after = /^\d{1,18}$/.test(since ?? "") ? (since as string) : "0";
  const rows = await deps.db.query<{
    seq: string;
    digest_id: string;
    version: number;
    status: string;
    content: { source: { project_key: string } } & Record<string, unknown>;
    agent: string;
    agent_session_id: string;
  }>(
    `SELECT d.review_seq::text AS seq, d.id AS digest_id, d.version, d.status, d.content,
            s.agent, s.agent_session_id
     FROM digests d JOIN sessions s ON s.id = d.session_id
     WHERE d.workspace_id = $1 AND d.review_seq > $2::bigint
     ORDER BY d.review_seq LIMIT 200`,
    [deps.workspaceId, after],
  );
  return {
    changes: rows.map((r) => ({
      agent: r.agent,
      agent_session_id: r.agent_session_id,
      project_key: r.content.source.project_key,
      digest_id: r.digest_id,
      version: r.version,
      status: r.status,
      ...(r.status === "approved" ? { digest: r.content } : {}),
    })),
    cursor: rows.at(-1)?.seq ?? after,
  };
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

/**
 * After an owner rename: make the bundle's latest approved digest deliverable again so the new
 * name reaches the replica in the normal flow (the replica treats the repeated digest as a no-op).
 */
export async function redeliverBundleName(q: Queryable, bundleId: string) {
  await q.query(
    `DELETE FROM sync_deliveries WHERE digest_id = (
       SELECT d.id FROM digests d
       JOIN sessions s ON s.id = d.session_id
       JOIN bundles b ON b.id = s.bundle_id
       JOIN projects p ON p.id = s.project_id
       WHERE b.id = $1 AND d.status = 'approved' AND COALESCE(b.sync_enabled, p.sync_enabled)
       ORDER BY d.approved_at DESC, d.id DESC LIMIT 1)`,
    [bundleId],
  );
}

export async function pending(deps: Pick<Deps, "db" | "rules" | "workspaceId">) {
  const digests = await deps.db.query<{
    digest_id: string;
    bundle_id: string;
    bundle_key: string | null;
    target: string;
    digest: unknown;
    approved_at: Date;
    sync_enabled_at: Date | null;
    project_name: string;
    bundle_name: string;
    bundle_name_source: string;
  }>(
    `SELECT d.id AS digest_id, b.id AS bundle_id, b.key AS bundle_key, p.sync_target AS target, d.content AS digest, d.approved_at,
            CASE WHEN b.sync_enabled IS NOT NULL THEN b.sync_enabled_at ELSE p.sync_enabled_at END AS sync_enabled_at,
            p.name AS project_name, b.name AS bundle_name, b.name_source AS bundle_name_source
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
    "SELECT id, target, source_type, source_key FROM sync_outgoing WHERE handed_at IS NULL AND source_type <> 'bundle_change' ORDER BY created_at, id",
  );
  const changes = await deps.db.query<{ id: string; target: string; payload: BundleChangeBody }>(
    "SELECT id, target, payload FROM sync_outgoing WHERE handed_at IS NULL AND source_type = 'bundle_change' ORDER BY created_at, id",
  );
  // Names leave the machine here: mask them like every other digest string (Constitution II). A
  // bundle's replica key is the masked key from its digests, so the tombstone key is masked too.
  const mask = (text: string) => deps.rules.redact(text).text;
  return {
    digests: digests.map(({ bundle_id, bundle_key, ...d }) => ({
      ...d,
      bundle_name: mask(d.bundle_name),
      bundle_ref: mask(bundleRef({ id: bundle_id, key: bundle_key })),
    })),
    tombstones: tombstones.map((t) =>
      t.source_type === "bundle" ? { ...t, source_key: mask(t.source_key) } : t,
    ),
    bundle_changes: changes.map((c) => ({
      id: c.id,
      target: c.target,
      change: { ...c.payload, bundle_ref: mask(c.payload.bundle_ref), name: mask(c.payload.name) },
    })),
  };
}

type BundleChangeBody = Omit<z.infer<typeof SyncBundleChangeSchema>, "outbox_id">;

/**
 * Owner's machine: queue the resulting state of a renamed, split or merged task for its publish
 * target (spec 007). Pending changes of one task coalesce into the latest state, which is sent
 * after every change queued before it. Only sessions with an approved digest are listed: nothing
 * else can be on the target.
 */
export async function queueBundleChange(q: Queryable, workspaceId: string, bundleId: string) {
  const [b] = await q.query<{
    id: string;
    key: string | null;
    name: string;
    name_source: "key" | "suggested" | "owner";
    repo_key: string;
    target: string | null;
    enabled: boolean;
  }>(
    `SELECT b.id, b.key, b.name, b.name_source, p.repo_key, p.sync_target AS target,
            COALESCE(b.sync_enabled, p.sync_enabled) AS enabled
     FROM bundles b JOIN projects p ON p.id = b.project_id WHERE b.id = $1 AND b.workspace_id = $2`,
    [bundleId, workspaceId],
  );
  if (!b?.enabled || !b.target) return false;
  const sessions = await q.query<{ agent: string; agent_session_id: string }>(
    `SELECT s.agent, s.agent_session_id FROM sessions s WHERE s.bundle_id = $1
       AND EXISTS (SELECT 1 FROM digests d WHERE d.session_id = s.id AND d.status = 'approved')
     ORDER BY s.ended_at, s.id`,
    [bundleId],
  );
  const payload: BundleChangeBody = {
    project_key: b.repo_key,
    bundle_ref: bundleRef(b),
    name: b.name,
    name_source: b.name_source,
    sessions,
  };
  await q.query(
    `INSERT INTO sync_outgoing (id, target, source_type, source_key, payload) VALUES ($1, $2, 'bundle_change', $3, $4)
     ON CONFLICT (target, source_type, source_key) WHERE handed_at IS NULL
     DO UPDATE SET payload = excluded.payload, created_at = now()`,
    [ulid(), b.target, b.id, JSON.stringify(payload)],
  );
  return true;
}

export async function ack(
  deps: Pick<Deps, "db">,
  a: {
    digests: { digest_id: string; target: string }[];
    tombstones: string[];
    bundle_changes?: string[] | undefined;
  },
) {
  await deps.db.tx(async (q) => {
    for (const d of a.digests) {
      await q.query(
        "INSERT INTO sync_deliveries (digest_id, target) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [d.digest_id, d.target],
      );
    }
    const handed = [...a.tombstones, ...(a.bundle_changes ?? [])];
    if (handed.length) {
      await q.query("UPDATE sync_outgoing SET handed_at = now() WHERE id = ANY($1)", [handed]);
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
      await queueTombstone(
        q,
        syncTarget,
        "bundle",
        bundleKey(b.repo_key, bundleRef({ id, key: b.key })),
      );
      await resetDeliveries(q, "s.bundle_id = $1", id);
    }
  });
}
