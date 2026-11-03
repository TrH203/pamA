// Pipeline runs (spec 006): types, query keys and fetchers for GET /v1/activity and friends.
// Responses mirror apps/server/src/services/runs.ts (RunView, PipelineCounts).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api.ts";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";
export type RunStage = "received" | "drafted" | "classified" | "embedded" | "stored";

export interface Run {
  id: string;
  kind: "transcript" | "draft";
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
  resumable: boolean;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface PipelineCounts {
  running: number;
  failed: number;
  awaiting_review: number;
  forwarded: number;
}

export interface RunPage {
  runs: Run[];
  next_cursor: string | null;
  counts: PipelineCounts;
}

export const STATUSES: RunStatus[] = ["running", "failed", "succeeded", "queued"];

/** "Started" filter presets. The ISO time is computed when fetching so the query key is stable. */
export const SINCE = ["1h", "24h", "7d", "30d"] as const;
export type Since = (typeof SINCE)[number];
const SINCE_MS: Record<Since, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export interface RunFilter {
  status?: RunStatus;
  since?: Since;
}

export function activityPath(f: RunFilter & { cursor?: string; limit?: number }, now = Date.now()) {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.since) p.set("since", new Date(now - SINCE_MS[f.since]).toISOString());
  if (f.cursor) p.set("cursor", f.cursor);
  if (f.limit) p.set("limit", String(f.limit));
  const qs = p.toString();
  return qs ? `/v1/activity?${qs}` : "/v1/activity";
}

/** Every activity query starts with this key, so one invalidation refreshes them all. */
export const ACTIVITY_KEY = ["activity"] as const;

export const activityQueries = {
  /** Latest runs plus the pipeline counts (Home, sidebar badge, Review empty state). */
  summary: {
    queryKey: [...ACTIVITY_KEY, "summary"],
    queryFn: () => api<RunPage>(activityPath({ limit: 20 })),
  },
  /** Recent failed runs for "Needs attention". */
  failed: {
    queryKey: [...ACTIVITY_KEY, "failed"],
    queryFn: () => api<RunPage>(activityPath({ status: "failed", limit: 20 })),
  },
  list: (f: RunFilter) => ({
    queryKey: [...ACTIVITY_KEY, "list", f.status ?? "all", f.since ?? "all"],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      api<RunPage>(activityPath({ ...f, cursor: pageParam, limit: 50 })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: RunPage) => last.next_cursor ?? undefined,
  }),
  run: (id: string) => ({
    queryKey: [...ACTIVITY_KEY, "run", id],
    queryFn: () => api<{ run: Run }>(`/v1/activity/${encodeURIComponent(id)}`),
  }),
};

export interface DigestInfo {
  id: string;
  status: "draft" | "approved" | "superseded" | "discarded" | "withdrawn";
  approved_at: string | null;
}

export const digestQuery = (id: string) => ({
  queryKey: ["digest", id],
  queryFn: () => api<DigestInfo>(`/v1/digests/${encodeURIComponent(id)}`),
});

/** POST /v1/activity/:id/retry; refreshes runs and the review queue when it settles. */
export function useRetryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ digest_id: string; run_id: string }>(`/v1/activity/${encodeURIComponent(id)}/retry`, {
        method: "POST",
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ACTIVITY_KEY });
      void qc.invalidateQueries({ queryKey: ["review"] });
    },
  });
}

/** The newer run id named in a 409 `superseded` message ("… exists (01J…); retry …"). */
export function newerRunId(message: string): string | null {
  return /\(([0-9A-HJKMNP-TV-Z]{26})\)/i.exec(message)?.[1] ?? null;
}

/**
 * Failed runs that still matter: the newest run per session, and only when no newer run of the
 * same session is known to be in flight or done.
 */
export function openFailures(failed: Run[], recent: Run[] = []): Run[] {
  const latest = new Map<string, Run>();
  for (const r of [...recent, ...failed]) {
    const key = `${r.agent}\u0000${r.agent_session_id}`;
    const cur = latest.get(key);
    if (!cur || r.id > cur.id) latest.set(key, r);
  }
  return [...latest.values()]
    .filter((r) => r.status === "failed")
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}
