// Digest versions and their lifecycle (data-model.md):
//   draft → approved → superseded (newer approved version) · draft → discarded ·
//   approved → withdrawn. Only the latest approved version of a session has active items.
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/client.ts";
import { HttpError } from "../http.ts";
import { classifyItems, sanitizeDeep } from "../pipeline/classify.ts";
import { embedTexts, toVector } from "../pipeline/embed.ts";
import { itemSearchText, itemsOf, type LabelMap } from "../pipeline/items.ts";
import { mergeRedactions } from "../pipeline/transcript.ts";
import { type SessionDigest, SessionDigestSchema } from "../schema/digest.ts";

export type PipelineDeps = Pick<Deps, "db" | "models" | "rules" | "workspaceId">;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Hash of the meaningful content (provenance excluded). */
export function digestHash(d: SessionDigest): string {
  const { provenance: _p, ...rest } = d;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

/** Layer 2 on a digest: rules over every string, then labels from the classifier. */
export async function cleanAndLabel(
  deps: PipelineDeps,
  digest: SessionDigest,
): Promise<{ digest: SessionDigest; labels: LabelMap }> {
  const { value, counts } = sanitizeDeep({ ...digest, redactions: undefined }, deps.rules);
  const cleaned = SessionDigestSchema.parse({
    ...value,
    redactions: mergeRedactions(digest.redactions, counts),
  });
  const items = itemsOf(cleaned);
  const labels = await classifyItems(deps.models.small, items);
  cleaned.decisions = cleaned.decisions.map((x) => {
    const l = labels[`d${x.id}`];
    return l?.length ? { ...x, labels: l } : { ...x, labels: undefined };
  });
  return { digest: SessionDigestSchema.parse(cleaned), labels };
}

interface StoreArgs {
  sessionId: string;
  bundleId: string;
  projectId: string;
  digest: SessionDigest;
  labels: LabelMap;
  status: "draft" | "approved";
}

/** Insert a new digest version with its items (inactive). Returns id and version. */
export async function storeVersion(deps: PipelineDeps, a: StoreArgs) {
  const items = itemsOf(a.digest);
  const vectors = await embedTexts(deps.models.embed, items.map(itemSearchText));
  return deps.db.tx(async (q) => {
    const [{ v } = { v: 0 }] = await q.query<{ v: number }>(
      "SELECT COALESCE(max(version), 0)::int AS v FROM digests WHERE session_id = $1",
      [a.sessionId],
    );
    const id = ulid();
    const version = v + 1;
    await q.query(
      `INSERT INTO digests (id, workspace_id, session_id, version, digest_hash, content, status, prompt_version, model, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        deps.workspaceId,
        a.sessionId,
        version,
        digestHash(a.digest),
        JSON.stringify(a.digest),
        a.status,
        a.digest.provenance?.prompt_version ?? null,
        a.digest.provenance?.model ?? null,
        a.status === "approved" ? new Date().toISOString() : null,
      ],
    );
    for (const [n, it] of items.entries()) {
      await q.query(
        `INSERT INTO digest_items (id, workspace_id, digest_id, session_id, bundle_id, project_id, kind, text, rationale, alternatives, labels, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)`,
        [
          `${id}#${it.local}`,
          deps.workspaceId,
          id,
          a.sessionId,
          a.bundleId,
          a.projectId,
          it.kind,
          it.text,
          it.rationale,
          it.alternatives,
          a.labels[it.local] ?? [],
          vectors[n] ? toVector(vectors[n]) : null,
        ],
      );
    }
    if (a.status === "approved") await activate(q, a.sessionId, id);
    return { id, version };
  });
}

/** Make `digestId` the only active version of its session. */
async function activate(q: Queryable, sessionId: string, digestId: string) {
  await q.query(
    "UPDATE digests SET status = 'superseded' WHERE session_id = $1 AND id <> $2 AND status IN ('approved', 'draft')",
    [sessionId, digestId],
  );
  await q.query("UPDATE digest_items SET active = (digest_id = $2) WHERE session_id = $1", [
    sessionId,
    digestId,
  ]);
}

interface DigestRow {
  id: string;
  session_id: string;
  version: number;
  status: string;
  content: SessionDigest;
  bundle_id: string;
  project_id: string;
}

async function load(deps: PipelineDeps, id: string): Promise<DigestRow> {
  const [row] = await deps.db.query<DigestRow>(
    `SELECT d.id, d.session_id, d.version, d.status, d.content, s.bundle_id, s.project_id
     FROM digests d JOIN sessions s ON s.id = d.session_id
     WHERE d.id = $1 AND d.workspace_id = $2`,
    [id, deps.workspaceId],
  );
  if (!row) throw new HttpError(404, "not_found", "digest not found");
  return row;
}

export async function approveDigest(
  deps: PipelineDeps,
  id: string,
  edited?: unknown,
  by = "owner",
): Promise<{ digest_id: string; version: number; status: "approved" }> {
  const row = await load(deps, id);
  if (row.status !== "draft" && row.status !== "approved") {
    throw new HttpError(409, "conflict", `cannot approve a ${row.status} digest`);
  }
  if (edited !== undefined) {
    const parsed = SessionDigestSchema.safeParse(edited);
    if (!parsed.success) throw new HttpError(422, "invalid_digest", parsed.error.message);
    const next: SessionDigest = { ...parsed.data, source: row.content.source };
    const { digest, labels } = await cleanAndLabel(deps, next);
    const v = await storeVersion(deps, {
      sessionId: row.session_id,
      bundleId: row.bundle_id,
      projectId: row.project_id,
      digest,
      labels,
      status: "approved",
    });
    await deps.db.query("UPDATE digests SET approved_by = $2 WHERE id = $1", [v.id, by]);
    return { digest_id: v.id, version: v.version, status: "approved" };
  }
  await deps.db.tx(async (q) => {
    await q.query(
      "UPDATE digests SET status = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1",
      [id, by],
    );
    await activate(q, row.session_id, id);
  });
  return { digest_id: id, version: row.version, status: "approved" };
}

export async function discardDigest(deps: PipelineDeps, id: string) {
  const row = await load(deps, id);
  if (row.status !== "draft")
    throw new HttpError(409, "conflict", `cannot discard a ${row.status} digest`);
  await deps.db.query("UPDATE digests SET status = 'discarded' WHERE id = $1", [id]);
}

/** Withdraw an approved digest: its items stop being retrievable immediately. */
export async function withdrawDigest(deps: PipelineDeps, id: string) {
  const row = await load(deps, id);
  if (row.status !== "approved")
    throw new HttpError(409, "conflict", `cannot withdraw a ${row.status} digest`);
  await deps.db.tx(async (q) => {
    await q.query("UPDATE digests SET status = 'withdrawn' WHERE id = $1", [id]);
    await q.query("UPDATE digest_items SET active = false WHERE digest_id = $1", [id]);
  });
}
