// Digest job (research R7): Layer-1-redacted events from the device → English Session Digest.
// Runs on the owner's machine (local sidecar) only; see routes/device.ts.
import { generateText, Output } from "ai";
import { ulid } from "ulid";
import { z } from "zod";
import { loadPrompt } from "../llm/prompts.ts";
import type { SessionDigest } from "../schema/digest.ts";
import {
  assignBundle,
  branchList,
  recordBranches,
  reevaluateSession,
} from "../services/bundles.ts";
import {
  approveDigest,
  cleanAndLabel,
  type PipelineDeps,
  storeVersion,
} from "../services/digests.ts";
import { autoApproveFor, upsertProject } from "../services/projects.ts";
import { sanitizeDeep } from "./classify.ts";
import {
  formatTranscript,
  inputHash,
  mergeRedactions,
  type Redactions,
  type TranscriptInput,
} from "./transcript.ts";

/** What the model writes; the server adds source, redactions and provenance. */
export const DraftSchema = z.object({
  goal: z.string(),
  decisions: z.array(
    z.object({
      what: z.string(),
      why: z.string(),
      alternatives: z.array(z.string()).default([]),
    }),
  ),
  outcome: z.string(),
  open_items: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]),
});

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export type DraftOutput = z.infer<typeof DraftSchema>;

/**
 * The model's draft → Session Digest (limits, ids, source). The thin client does the same on the
 * device in Rust (`pama_core::draft::build_digest`); `packages/types/fixtures/draft/` keeps them
 * in step.
 */
export function shapeDraft(
  input: TranscriptInput,
  output: DraftOutput,
  recheck: Redactions,
  provenance?: SessionDigest["provenance"],
): SessionDigest {
  return {
    schema_version: 1,
    source: {
      agent: input.agent,
      agent_session_id: input.agent_session_id,
      ...(input.agent_version ? { agent_version: input.agent_version } : {}),
      project_key: input.project_key,
      bundle_key: input.bundle_key || input.git?.branch || "default",
      ...(input.git ? { git: input.git } : {}),
      ...(input.started_at ? { started_at: input.started_at } : {}),
      ended_at: input.ended_at,
    },
    goal: cut(output.goal.trim() || "Session without a stated goal.", 1000),
    decisions: output.decisions.slice(0, 30).map((d, i) => ({
      id: i + 1,
      what: cut(d.what, 1000),
      why: cut(d.why, 1000),
      alternatives: d.alternatives.slice(0, 10).map((a) => cut(a, 500)),
    })),
    outcome: cut(output.outcome, 1000),
    open_items: output.open_items.slice(0, 20).map((s) => cut(s, 500)),
    modules: output.modules.slice(0, 30).map((s) => cut(s, 100)),
    redactions: mergeRedactions(input.redactions, recheck),
    ...(provenance ? { provenance } : {}),
  };
}

export interface DigestResult {
  digest_id: string;
  version: number;
  status: "draft" | "approved";
  session_id: string;
  bundle_id: string;
}

export async function digestTranscript(
  deps: PipelineDeps,
  input: TranscriptInput,
): Promise<DigestResult> {
  const ws = deps.workspaceId;
  const hash = inputHash(input);
  const project = await upsertProject(deps.db, ws, input.project_key, input.project_name);
  const bundleKey = input.bundle_key || input.git?.branch || "default";

  // Session (keeps its bundle if the owner moved it).
  let [session] = await deps.db.query<{ id: string; bundle_id: string; input_hash: string | null }>(
    "SELECT id, bundle_id, input_hash FROM sessions WHERE workspace_id = $1 AND agent = $2 AND agent_session_id = $3",
    [ws, input.agent, input.agent_session_id],
  );
  const existed = Boolean(session);
  if (!session) {
    const bundleId = await assignBundle(deps.db, ws, project.id, bundleKey);
    [session] = await deps.db.query(
      `INSERT INTO sessions (id, workspace_id, project_id, bundle_id, agent, agent_session_id, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id, agent, agent_session_id) DO UPDATE SET ended_at = excluded.ended_at
       RETURNING id, bundle_id, input_hash`,
      [
        ulid(),
        ws,
        project.id,
        bundleId,
        input.agent,
        input.agent_session_id,
        input.started_at ?? null,
        input.ended_at,
      ],
    );
  }
  if (!session) throw new Error("session upsert failed");

  // Branches (names redacted like every digest string) and, for an existing unpinned session,
  // re-filing; both run even when the events are unchanged.
  const git = sanitizeDeep(input.git ?? {}, deps.rules).value;
  await recordBranches(deps.db, ws, session.id, branchList(git));
  if (existed) {
    session.bundle_id = await reevaluateSession(deps.db, ws, project.id, session.id, bundleKey);
  }
  if (existed && session.input_hash === hash) {
    const [latest] = await deps.db.query<{ id: string; version: number; status: string }>(
      "SELECT id, version, status FROM digests WHERE session_id = $1 ORDER BY version DESC LIMIT 1",
      [session.id],
    );
    if (latest && (latest.status === "draft" || latest.status === "approved")) {
      return {
        digest_id: latest.id,
        version: latest.version,
        status: latest.status,
        session_id: session.id,
        bundle_id: session.bundle_id,
      };
    }
  }

  // Layer 1 re-check on the server side of the device boundary.
  const recheck = deps.rules.redact(formatTranscript(input.events));
  const prompt = loadPrompt("digest");
  const { output } = await generateText({
    model: deps.models.small,
    system: prompt.body,
    prompt: `<transcript>\n${recheck.text}\n</transcript>`,
    output: Output.object({ schema: DraftSchema }),
    temperature: 0,
  });

  const raw = shapeDraft(input, output, recheck.counts, {
    prompt_version: prompt.version,
    model: String((deps.models.small as { modelId?: string }).modelId ?? "unknown"),
    produced_at: new Date().toISOString(),
  });
  const { digest, labels } = await cleanAndLabel(deps, raw);

  const stored = await storeVersion(deps, {
    sessionId: session.id,
    bundleId: session.bundle_id,
    projectId: project.id,
    digest,
    labels,
    status: "draft",
  });
  await deps.db.query("UPDATE sessions SET input_hash = $2, redaction_counts = $3 WHERE id = $1", [
    session.id,
    hash,
    JSON.stringify({ secret: digest.redactions.secret, pii: digest.redactions.pii }),
  ]);

  let status: DigestResult["status"] = "draft";
  if (await autoApproveFor(deps.db, project.id)) {
    await approveDigest(deps, stored.id, undefined, "auto");
    status = "approved";
  }
  return {
    digest_id: stored.id,
    version: stored.version,
    status,
    session_id: session.id,
    bundle_id: session.bundle_id,
  };
}
