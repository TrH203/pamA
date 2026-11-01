// The tail of every digest run (spec 006): embed, store, bookkeeping, auto-approve. Its input is
// what a run keeps in `digest_runs.resume` after classification, so a run that failed while
// embedding is retried from here without calling the drafting or classifying models again.
import type { SessionDigest } from "../schema/digest.ts";
import { approveDigest, digestHash, type PipelineDeps, storeVersion } from "../services/digests.ts";
import { autoApproveFor } from "../services/projects.ts";
import type { RunTracker } from "../services/runs.ts";
import { remember } from "../services/sync.ts";
import type { LabelMap } from "./items.ts";

export interface ResumeState {
  /** transcript runs: hash of the request; draft runs: hash of the device's digest. */
  input_hash: string;
  session_id: string;
  bundle_id: string;
  project_id: string;
  digest: SessionDigest;
  labels: LabelMap;
  /** Draft runs: the stored content hash (the device's) and where it came from. */
  content_hash?: string;
  origin_device_id?: string;
  outbox_id?: string;
}

export interface Completed {
  digest_id: string;
  version: number;
  status: "draft" | "approved";
}

export async function completeDigest(
  deps: PipelineDeps,
  r: ResumeState,
  run?: RunTracker,
): Promise<Completed> {
  // Idempotent: a run that failed after storing (auto-approve, bookkeeping) and is retried, or
  // resumed by a resubmission, finds its version instead of storing it twice.
  const hash = r.content_hash ?? digestHash(r.digest);
  const [existing] = await deps.db.query<{ id: string; version: number; status: string }>(
    `SELECT id, version, status FROM digests WHERE session_id = $1 AND digest_hash = $2
       AND status IN ('draft', 'approved')`,
    [r.session_id, hash],
  );
  if (existing) await run?.stage("embedded");
  const stored =
    existing ??
    (await storeVersion(deps, {
      sessionId: r.session_id,
      bundleId: r.bundle_id,
      projectId: r.project_id,
      digest: r.digest,
      labels: r.labels,
      status: "draft",
      ...(r.content_hash ? { hash: r.content_hash } : {}),
      onEmbedded: async () => {
        await run?.stage("embedded");
      },
    }));
  if (r.origin_device_id) {
    await deps.db.query("UPDATE digests SET origin_device_id = $2 WHERE id = $1", [
      stored.id,
      r.origin_device_id,
    ]);
  } else {
    await deps.db.query(
      "UPDATE sessions SET input_hash = $2, redaction_counts = $3 WHERE id = $1",
      [
        r.session_id,
        r.input_hash,
        JSON.stringify({ secret: r.digest.redactions.secret, pii: r.digest.redactions.pii }),
      ],
    );
  }
  let status: Completed["status"] = existing?.status === "approved" ? "approved" : "draft";
  if (status === "draft" && (await autoApproveFor(deps.db, r.project_id))) {
    await approveDigest(deps, stored.id, undefined, "auto");
    status = "approved";
  }
  const result: Completed = { digest_id: stored.id, version: stored.version, status };
  if (r.outbox_id && r.origin_device_id) {
    await remember(deps.db, r.outbox_id, r.origin_device_id, result);
  }
  return result;
}
