// Draft requests. `answer_source` (FR-029): `local` uses the server on this machine (same origin
// as this page); `server` and `auto` use a paired remote server once sync is set up (US4) and
// fall back to local.
import { ipc } from "./ipc.ts";

export interface SourceRef {
  type: "project" | "bundle" | "session";
  id: string;
}

export interface Draft {
  ask_id: string;
  status: "answered" | "refused";
  answer?: string;
  reason?: string;
  citations: { item_id: string; label: string }[];
  confidence: number;
  language: string;
  suggested_scope: { type: "bundle"; id: string; title: string }[];
}

/** A hotkey draft recorded by the server (GET /v1/draft/recent, spec 008). */
export interface RecentDraft {
  ask_id: string;
  conversation_id: string | null;
  question: string;
  answer: string | null;
  reason: string | null;
  citations: { item_id: string; label?: string }[];
  language: string | null;
  created_at: string;
}

/** A recent draft as the popup shows a fresh one (no confidence or scope suggestion kept). */
export const recentToDraft = (r: RecentDraft): Draft => ({
  ask_id: r.ask_id,
  status: r.answer ? "answered" : "refused",
  ...(r.answer ? { answer: r.answer } : { reason: r.reason ?? "out_of_scope" }),
  citations: r.citations.map((c) => ({ item_id: c.item_id, label: c.label ?? "" })),
  confidence: 0,
  language: r.language ?? "en",
  suggested_scope: [],
});

let tokenCache: string | null = null;

async function token(): Promise<string> {
  if (!tokenCache) tokenCache = (await ipc.sidecarStatus()).token;
  if (!tokenCache) throw new Error("The local pamA server is not running.");
  return tokenCache;
}

async function call<T>(path: string, json?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: json === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${await token()}`,
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error((body as { error?: { message?: string } }).error?.message ?? res.statusText);
  return body as T;
}

export const draftApi = {
  draft: (question: string, opts: { scope_hint?: SourceRef[]; shorter?: boolean } = {}) =>
    call<Draft>("/v1/draft", { question, ...opts }),
  bundles: () => call<{ items: { id: string; name: string; project: string }[] }>("/v1/bundles"),
  projects: () => call<{ items: { id: string; name: string }[] }>("/v1/projects"),
  recent: (limit = 20) => call<{ items: RecentDraft[] }>(`/v1/draft/recent?limit=${limit}`),
  syncStatus: () =>
    call<{
      projects: {
        id: string;
        name: string;
        repo_key: string;
        sync_enabled: boolean;
        sync_target: string | null;
        bundles: {
          id: string;
          name: string;
          key: string | null;
          sync_enabled: boolean | null;
          branches: string[];
          session_count: number;
          last_activity: string | null;
        }[];
      }[];
    }>("/v1/sync/status"),
  networkLog: () =>
    call<{
      items: {
        id: string;
        at: number;
        component: string;
        host: string;
        purpose: string;
        allowed: boolean;
      }[];
    }>("/v1/network-log"),
};
