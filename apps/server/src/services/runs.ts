// Digest pipeline runs (spec 006). Every digest request on this server — a transcript from the
// owner's own device or a draft from a thin-client device — gets a `digest_runs` row that moves
// through `received → drafted → classified → embedded → stored` and ends `succeeded` or `failed`
// with a coded error (provider_unreachable, provider_auth, rate_limited, model_timeout, ...).
// Changes are published on an in-process bus that `GET /v1/events` streams to the console.
import { EventEmitter } from "node:events";
import { ulid } from "ulid";
import type { Queryable } from "../db/client.ts";
import { HttpError } from "../http.ts";
import { modelHttpError, modelTagOf } from "../llm/errors.ts";

export type RunKind = "transcript" | "draft";
export type RunStage = "received" | "drafted" | "classified" | "embedded" | "stored";
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

/** What the API shows for a run (the `resume` blob stays on the server). */
export interface RunView {
  id: string;
  kind: RunKind;
  agent: string;
  agent_session_id: string;
  project_key: string | null;
  stage: RunStage;
  status: RunStatus;
  error_code: string | null;
  error_message: string | null;
  role: string | null;
  provider: string | null;
  model: string | null;
  digest_id: string | null;
  attempts: number;
  /** A retry can run on the server (the drafted output was kept). */
  resumable: boolean;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface RunEvent {
  workspaceId: string;
  run: RunView;
}

/** In-process bus: `run` events for SSE subscribers in this process. */
export const runBus = new EventEmitter();
runBus.setMaxListeners(0);

const COLUMNS = `id, kind, agent, agent_session_id, project_key, stage, status, error_code, error_message,
  role, provider, model, digest_id, attempts, (resume IS NOT NULL) AS resumable,
  started_at, updated_at, finished_at`;

type Row = Omit<RunView, "started_at" | "updated_at" | "finished_at" | "duration_ms"> & {
  started_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
};

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

export function toView(r: Row): RunView {
  const started = iso(r.started_at);
  const finished = r.finished_at ? iso(r.finished_at) : null;
  return {
    ...r,
    resumable: Boolean(r.resumable),
    started_at: started,
    updated_at: iso(r.updated_at),
    finished_at: finished,
    duration_ms: finished ? Date.parse(finished) - Date.parse(started) : null,
  };
}

/** A failure as stored on a run: code, readable message and, for model calls, who failed. */
export interface RunFailure {
  code: string;
  message: string;
  role: string | null;
  provider: string | null;
  model: string | null;
}

export function describeFailure(err: unknown): RunFailure {
  const tag = modelTagOf(err);
  const who = {
    role: tag?.role ?? null,
    provider: tag?.provider ?? null,
    model: tag?.model ?? null,
  };
  if (err instanceof HttpError) return { code: err.code, message: err.message, ...who };
  const model = modelHttpError(err);
  if (model) return { code: model.code, message: model.message, ...who };
  const message = err instanceof Error ? err.message : String(err);
  return { code: "internal", message: message.slice(0, 500) || "internal error", ...who };
}

export async function loadRun(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<RunView | null> {
  const [r] = await db.query<Row>(
    `SELECT ${COLUMNS} FROM digest_runs WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return r ? toView(r) : null;
}

/** Tracks one run; every change is written and published. */
export class RunTracker {
  constructor(
    readonly db: Queryable,
    readonly workspaceId: string,
    readonly id: string,
  ) {}

  async publish() {
    const run = await loadRun(this.db, this.workspaceId, this.id);
    if (run) runBus.emit("run", { workspaceId: this.workspaceId, run } satisfies RunEvent);
  }

  /** Reached `stage`. `resume` (drafted output) is kept so a retry can skip the model calls. */
  async stage(stage: RunStage, resume?: unknown) {
    await this.db.query(
      `UPDATE digest_runs SET stage = $2, status = 'running', updated_at = now(),
         resume = COALESCE($3::jsonb, resume) WHERE id = $1`,
      [this.id, stage, resume === undefined ? null : JSON.stringify(resume)],
    );
    await this.publish();
  }

  async succeed(digestId: string) {
    await this.db.query(
      `UPDATE digest_runs SET stage = 'stored', status = 'succeeded', digest_id = $2, resume = NULL,
         error_code = NULL, error_message = NULL, role = NULL, provider = NULL, model = NULL,
         updated_at = now(), finished_at = now() WHERE id = $1`,
      [this.id, digestId],
    );
    await this.publish();
  }

  async fail(err: unknown): Promise<RunFailure> {
    const f = describeFailure(err);
    await this.db.query(
      `UPDATE digest_runs SET status = 'failed', error_code = $2, error_message = $3, role = $4,
         provider = $5, model = $6, updated_at = now(), finished_at = now() WHERE id = $1`,
      [this.id, f.code, f.message, f.role, f.provider, f.model],
    );
    await this.publish();
    return f;
  }
}

export async function startRun(
  db: Queryable,
  workspaceId: string,
  s: { kind: RunKind; agent: string; agent_session_id: string; project_key?: string | null },
): Promise<RunTracker> {
  const id = ulid();
  await db.query(
    `INSERT INTO digest_runs (id, workspace_id, kind, agent, agent_session_id, project_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, workspaceId, s.kind, s.agent, s.agent_session_id, s.project_key ?? null],
  );
  const t = new RunTracker(db, workspaceId, id);
  await t.publish();
  return t;
}

/** Re-open a failed run for a retry on the server. */
export async function reopenRun(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<RunTracker> {
  await db.query(
    `UPDATE digest_runs SET status = 'running', attempts = attempts + 1, error_code = NULL,
       error_message = NULL, role = NULL, provider = NULL, model = NULL, finished_at = NULL,
       updated_at = now() WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return new RunTracker(db, workspaceId, id);
}

/** The kept output of the latest failed run of a session, when it matches `inputHash`. */
export async function resumableFor<T>(
  db: Queryable,
  workspaceId: string,
  agent: string,
  agentSessionId: string,
  inputHash: string,
): Promise<{ id: string; resume: T } | null> {
  const [r] = await db.query<{ id: string; resume: T }>(
    `SELECT id, resume FROM digest_runs
     WHERE workspace_id = $1 AND agent = $2 AND agent_session_id = $3 AND status = 'failed'
       AND resume IS NOT NULL AND resume->>'input_hash' = $4
     ORDER BY id DESC LIMIT 1`,
    [workspaceId, agent, agentSessionId, inputHash],
  );
  return r ?? null;
}

export interface RunFilter {
  status?: RunStatus;
  since?: string;
  /** Run id from the previous page's `next_cursor`. */
  cursor?: string;
  limit: number;
}

export async function listRuns(db: Queryable, workspaceId: string, f: RunFilter) {
  const where = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  if (f.status) {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  if (f.since) {
    params.push(f.since);
    where.push(`started_at >= $${params.length}`);
  }
  if (f.cursor) {
    params.push(f.cursor);
    where.push(`id < $${params.length}`);
  }
  params.push(f.limit + 1);
  const rows = await db.query<Row>(
    `SELECT ${COLUMNS} FROM digest_runs WHERE ${where.join(" AND ")}
     ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > f.limit;
  const runs = rows.slice(0, f.limit).map(toView);
  return { runs, next_cursor: more ? (runs.at(-1)?.id ?? null) : null };
}

export interface PipelineCounts {
  running: number;
  failed: number;
  awaiting_review: number;
  forwarded: number;
}

/** Counts for badges and `pama status`: failed = runs whose latest attempt for the session failed. */
export async function pipelineCounts(db: Queryable, workspaceId: string): Promise<PipelineCounts> {
  const [runs] = await db.query<{ running: number; failed: number }>(
    `SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS running,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM (SELECT DISTINCT ON (agent, agent_session_id) status FROM digest_runs
           WHERE workspace_id = $1 ORDER BY agent, agent_session_id, id DESC) latest`,
    [workspaceId],
  );
  const [review] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM digests WHERE workspace_id = $1 AND status = 'draft'",
    [workspaceId],
  );
  const [inbox] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM asks WHERE workspace_id = $1 AND status = 'forwarded'",
    [workspaceId],
  );
  return {
    running: runs?.running ?? 0,
    failed: runs?.failed ?? 0,
    awaiting_review: review?.n ?? 0,
    forwarded: inbox?.n ?? 0,
  };
}
