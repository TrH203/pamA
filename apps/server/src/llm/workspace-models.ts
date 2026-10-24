// Per-workspace answering model on cloud servers (spec 004, FR-026, research R7). The operator's
// models are the default; an owner may bring their own chat provider and key for their workspace.
// Embedding and small models stay operator-wide (one vector index, one digest model).
import type { Deps } from "../app.ts";
import type { ProviderConfig } from "../config.ts";
import { HttpError } from "../http.ts";
import { type CheckResult, checkProvider } from "./check.ts";
import { isLocal, language, type Models } from "./providers.ts";
import { type ApplyInput, decryptKey, encryptKey } from "./settings.ts";

interface Stored {
  provider: ProviderConfig["provider"];
  model: string;
  baseUrl?: string;
  apiKeyEnc?: string;
}

/** Workspace → its chat override (null: none). Cleared on every write. */
const cache = new Map<string, ProviderConfig | null>();

const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i;

/**
 * A tenant's endpoint is called by the server: only public HTTPS hosts, never loopback, private
 * ranges or IP literals (no server-side request forgery into the operator's network).
 */
export function assertPublicEndpoint(p: ProviderConfig): void {
  if (p.provider === "ollama") {
    throw new HttpError(
      422,
      "invalid_request",
      "Ollama runs on your machine; the cloud server cannot reach it.",
    );
  }
  if (!p.baseUrl) return;
  const u = new URL(p.baseUrl);
  if (u.protocol !== "https:" || IP_LITERAL.test(u.hostname) || isLocal(p)) {
    throw new HttpError(
      422,
      "invalid_request",
      "Use a public https:// endpoint for your own model.",
    );
  }
}

async function load(deps: Pick<Deps, "db" | "config">, workspaceId: string) {
  if (cache.has(workspaceId)) return cache.get(workspaceId) ?? null;
  const [row] = await deps.db.query<{ config: Stored }>(
    "SELECT config FROM workspace_model_settings WHERE workspace_id = $1 AND role = 'chat'",
    [workspaceId],
  );
  const p: ProviderConfig | null = row
    ? {
        provider: row.config.provider,
        model: row.config.model,
        ...(row.config.baseUrl ? { baseUrl: row.config.baseUrl } : {}),
        ...(row.config.apiKeyEnc
          ? { apiKey: decryptKey(deps.config.secret, row.config.apiKeyEnc) }
          : {}),
      }
    : null;
  cache.set(workspaceId, p);
  return p;
}

/** The models for requests of `workspaceId`: the operator's, with the workspace's chat model. */
export async function modelsFor(deps: Deps, workspaceId: string): Promise<Models> {
  if (deps.config.mode !== "cloud") return deps.models;
  const p = await load(deps, workspaceId);
  if (!p) return deps.models;
  return {
    ...deps.models,
    chat: language(p, deps.guard, deps.models.fake, "llm.chat"),
    local: false,
  };
}

export async function workspaceChatView(deps: Deps) {
  const p = await load(deps, deps.workspaceId);
  if (!p) return null;
  return {
    provider: p.provider,
    model: p.model,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    keySet: Boolean(p.apiKey),
    local: false,
    verified: true,
    source: "saved" as const,
    scope: "workspace" as const,
  };
}

export async function applyWorkspaceChat(deps: Deps, input: ApplyInput) {
  const cur = await load(deps, deps.workspaceId);
  const apiKey = input.apiKey ?? (cur?.provider === input.provider ? cur.apiKey : undefined);
  const cand: ProviderConfig = {
    provider: input.provider,
    model: input.model,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  assertPublicEndpoint(cand);
  if (!cand.apiKey) throw new HttpError(422, "invalid_request", "An API key is required.");
  const check: CheckResult = await checkProvider("chat", cand, deps.guard, deps.models.fake);
  if (!check.ok && !input.confirm.includes("unverified")) {
    throw Object.assign(
      new HttpError(422, "check_failed", check.items.find((i) => !i.ok)?.detail ?? "check failed"),
      { check },
    );
  }
  const stored: Stored = {
    provider: cand.provider,
    model: cand.model,
    ...(cand.baseUrl ? { baseUrl: cand.baseUrl } : {}),
    apiKeyEnc: encryptKey(deps.config.secret, cand.apiKey as string),
  };
  await deps.db.query(
    `INSERT INTO workspace_model_settings (workspace_id, role, config, updated_at) VALUES ($1, 'chat', $2::jsonb, now())
     ON CONFLICT (workspace_id, role) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [deps.workspaceId, JSON.stringify(stored)],
  );
  cache.delete(deps.workspaceId);
  return { ...(await workspaceChatView(deps)), check };
}

export async function revertWorkspaceChat(deps: Deps) {
  const rows = await deps.db.query(
    "DELETE FROM workspace_model_settings WHERE workspace_id = $1 AND role = 'chat' RETURNING 1",
    [deps.workspaceId],
  );
  cache.delete(deps.workspaceId);
  if (!rows.length)
    throw new HttpError(409, "no_previous", "this workspace uses the server's model");
  return {
    scope: "server" as const,
    provider: deps.config.chat.provider,
    model: deps.config.chat.model,
  };
}
