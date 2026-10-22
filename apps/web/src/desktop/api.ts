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
};
