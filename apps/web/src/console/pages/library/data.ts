// Library data (spec 007): shapes of the owner routes in apps/server/src/routes/library.ts and
// review.ts (bundles), and the TanStack Query hooks the Library pages share. The UI says "Task";
// the API keeps "bundle".
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api.ts";

export type SessionStatus = "draft" | "approved" | "discarded" | "withdrawn";
export type DigestStatus = SessionStatus | "superseded";
export const SESSION_STATUSES = ["draft", "approved", "discarded", "withdrawn", "none"] as const;
export const DIGEST_STATUSES = [
  "draft",
  "approved",
  "discarded",
  "withdrawn",
  "superseded",
] as const;
export const AGENTS = ["claude_code", "codex", "cursor", "opencode"] as const;

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
}

export interface Bundle {
  id: string;
  name: string;
  name_source: "key" | "suggested" | "owner";
  key: string | null;
  project: string;
  project_id: string;
  project_key?: string;
  branches: string[];
  session_count: number;
  last_activity: string | null;
  sessions: {
    id: string;
    agent: string;
    agent_session_id: string;
    ended_at: string | null;
    branches: string[];
    bundle_pinned: boolean;
  }[];
}

export interface Project {
  id: string;
  name: string;
  repo_key: string;
  auto_approve: boolean | null;
  sync_enabled?: boolean;
  sync_target?: string | null;
}

export interface SessionRow {
  id: string;
  agent: string;
  agent_session_id: string;
  started_at: string | null;
  ended_at: string | null;
  bundle_pinned: boolean;
  project_id: string;
  project: string;
  bundle_id: string;
  bundle: string;
  status: SessionStatus | null;
  goal: string | null;
  versions: number;
  branches: string[];
}

export interface SessionDetail {
  id: string;
  agent: string;
  agent_session_id: string;
  started_at: string | null;
  ended_at: string | null;
  bundle_pinned: boolean;
  created_at: string;
  project_id: string;
  project: string;
  project_key: string;
  bundle_id: string;
  bundle: string;
  status: SessionStatus | null;
  branches: {
    name: string;
    first_seen_at: string | null;
    last_seen_at: string | null;
    event_count: number;
  }[];
  digests: {
    id: string;
    version: number;
    status: DigestStatus;
    created_at: string;
    approved_at: string | null;
    model: string | null;
    prompt_version: string | null;
    goal: string | null;
    device: string | null;
  }[];
  links: { slug: string; title: string; expires_at: string }[];
  /** The server does not see the device's capture pipeline. */
  capture: unknown;
}

export interface DigestRow {
  id: string;
  session_id: string;
  version: number;
  status: DigestStatus;
  created_at: string;
  approved_at: string | null;
  goal: string | null;
  decisions: number;
  agent: string;
  agent_session_id: string;
  project_id: string;
  project: string;
  bundle_id: string;
  bundle: string;
}

export interface SearchHit {
  id: string;
  kind: string;
  text: string;
  rationale: string | null;
  labels: string[] | null;
  score: number;
  digest_id: string;
  digest_version: number;
  session_id: string;
  bundle_id: string;
  bundle: string;
  project_id: string | null;
  project: string | null;
  ended_at: string | null;
}

export interface DigestFull {
  id: string;
  session_id: string;
  version: number;
  status: DigestStatus;
  content: {
    goal: string;
    decisions: { id: number; what: string; why: string; alternatives?: string[] }[];
    outcome: string;
    open_items: string[];
    modules: string[];
  };
  created_at: string;
  approved_at: string | null;
}

/** `?a=1&b=2` from the defined, non-empty entries. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const PAGE_SIZE = 50;

export const keys = {
  bundles: ["bundles"] as const,
  projects: ["projects"] as const,
  library: ["library"] as const,
  publish: ["sync", "status"] as const,
};

export function useBundles() {
  return useQuery({
    queryKey: keys.bundles,
    queryFn: () => api<{ items: Bundle[] }>("/v1/bundles"),
  });
}

export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: () => api<{ items: Project[] }>("/v1/projects"),
  });
}

interface SyncStatus {
  projects: {
    id: string;
    sync_enabled: boolean;
    sync_target: string | null;
    bundles: { id: string; sync_enabled: boolean | null }[];
  }[];
}

/**
 * Publish state per task id (local mode only: `/v1/sync/status` lives on the owner's machine).
 * Undefined when the server has no publish concept, so the UI shows nothing rather than guessing.
 */
export function usePublishState(): Map<string, boolean> | undefined {
  const q = useQuery({
    queryKey: keys.publish,
    queryFn: () => api<SyncStatus>("/v1/sync/status"),
    retry: false,
    staleTime: 60_000,
  });
  if (!q.data) return undefined;
  const out = new Map<string, boolean>();
  for (const p of q.data.projects) {
    for (const b of p.bundles) {
      out.set(b.id, Boolean(p.sync_target) && (b.sync_enabled ?? p.sync_enabled));
    }
  }
  return out;
}

export interface SessionFilter {
  project?: string | undefined;
  bundle?: string | undefined;
  agent?: string | undefined;
  status?: string | undefined;
}

export function useSessions(f: SessionFilter, offset: number) {
  return useQuery({
    queryKey: [...keys.library, "sessions", f, offset],
    queryFn: () => api<Paged<SessionRow>>(`/v1/sessions${qs({ ...f, limit: PAGE_SIZE, offset })}`),
    placeholderData: keepPreviousData,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: [...keys.library, "session", id],
    queryFn: () => api<SessionDetail>(`/v1/sessions/${encodeURIComponent(id)}`),
  });
}

export interface DigestFilter {
  project?: string | undefined;
  bundle?: string | undefined;
  status?: string | undefined;
}

export function useDigests(f: DigestFilter, offset: number) {
  return useQuery({
    queryKey: [...keys.library, "digests", f, offset],
    queryFn: () => api<Paged<DigestRow>>(`/v1/digests${qs({ ...f, limit: PAGE_SIZE, offset })}`),
    placeholderData: keepPreviousData,
  });
}

export function useDigest(id: string | undefined) {
  return useQuery({
    queryKey: ["digest", id],
    queryFn: () => api<DigestFull>(`/v1/digests/${encodeURIComponent(id ?? "")}`),
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useSearchLibrary(q: string) {
  return useQuery({
    queryKey: [...keys.library, "search", q],
    queryFn: () => api<{ mode: "hybrid" | "text"; items: SearchHit[] }>(`/v1/search${qs({ q })}`),
    enabled: q.trim().length > 0,
  });
}

/** After a task or session change: tasks, library lists, publish state and the review queue. */
export function useLibraryRefresh() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.bundles }),
      qc.invalidateQueries({ queryKey: keys.library }),
      qc.invalidateQueries({ queryKey: keys.publish }),
      qc.invalidateQueries({ queryKey: ["review"] }),
    ]);
}

// Task changes (review.ts bundle routes).
export const taskApi = {
  rename: (id: string, name: string) =>
    api(`/v1/bundles/${encodeURIComponent(id)}`, { method: "PATCH", json: { name } }),
  merge: (bundleIds: string[], name: string) =>
    api<{ id: string }>("/v1/bundles/merge", { json: { bundle_ids: bundleIds, name } }),
  split: (id: string, sessionIds: string[], newName: string) =>
    api<{ id: string }>(`/v1/bundles/${encodeURIComponent(id)}/split`, {
      json: { session_ids: sessionIds, new_name: newName },
    }),
  /**
   * Move one session to another task of the same project. There is no single route for it: split
   * the session out of its task, then merge that new task into the target (merge keeps the first
   * id and its name). Sessions moved this way are pinned, like any owner move.
   */
  async moveSession(
    session: { id: string; bundle_id: string },
    target: { id: string; name: string },
  ) {
    const tmp = await taskApi.split(session.bundle_id, [session.id], target.name);
    return taskApi.merge([target.id, tmp.id], target.name);
  },
};
