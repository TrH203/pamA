// Runtime model settings (spec 003): saved overrides over env defaults, applied by hot-swapping the
// shared Models object. API keys are encrypted with the server secret and never returned.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { Config, ProviderConfig } from "../config.ts";
import type { Db } from "../db/client.ts";
import { HttpError } from "../http.ts";
import { embedTexts, toVector } from "../pipeline/embed.ts";
import { type CheckResult, checkProvider, type Role, staticItems } from "./check.ts";
import { createModels, isLocal } from "./providers.ts";

export const ROLES: Role[] = ["chat", "small", "embed"];

export const ApplySchema = z.object({
  provider: z.enum(["anthropic", "openai-compatible", "ollama"]),
  model: z.string().trim().min(1),
  baseUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  confirm: z.array(z.enum(["data_leaves", "reindex", "unverified"])).default([]),
});
export type ApplyInput = z.infer<typeof ApplySchema>;

export function parseRole(s: string): Role {
  if (!(ROLES as string[]).includes(s)) {
    throw new HttpError(422, "invalid_request", `role must be one of ${ROLES.join(", ")}`);
  }
  return s as Role;
}

const aesKey = (secret: string) => createHash("sha256").update(secret).digest();

export function encryptKey(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aesKey(secret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function decryptKey(secret: string, enc: string): string {
  const b = Buffer.from(enc, "base64url");
  const d = createDecipheriv("aes-256-gcm", aesKey(secret), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

interface Stored {
  provider: ProviderConfig["provider"];
  model: string;
  baseUrl?: string;
  apiKeyEnc?: string;
}

function toStored(secret: string, p: ProviderConfig): Stored {
  return {
    provider: p.provider,
    model: p.model,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(p.apiKey ? { apiKeyEnc: encryptKey(secret, p.apiKey) } : {}),
  };
}

function fromStored(secret: string, s: Stored): ProviderConfig {
  return {
    provider: s.provider,
    model: s.model,
    ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}),
    ...(s.apiKeyEnc ? { apiKey: decryptKey(secret, s.apiKeyEnc) } : {}),
  };
}

interface Row {
  role: Role;
  config: Stored;
  previous: Stored | null;
  last_check: CheckResult | null;
  verified: boolean;
}

/** At startup: let saved settings override the env defaults before models are created. */
export async function overlaySaved(db: Db, config: Config): Promise<void> {
  const rows = await db.query<Row>("SELECT role, config FROM model_settings");
  for (const r of rows) config[r.role] = fromStored(config.secret, r.config);
}

export interface RoleView {
  provider: string;
  model: string;
  baseUrl?: string;
  keySet: boolean;
  local: boolean;
  verified: boolean;
  source: "env" | "saved";
  previous?: { provider: string; model: string; baseUrl?: string };
  lastCheck?: CheckResult;
}

function view(p: ProviderConfig, row?: Row): RoleView {
  const prev = row?.previous;
  return {
    provider: p.provider,
    model: p.model,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    keySet: Boolean(p.apiKey),
    local: isLocal(p),
    verified: row?.verified ?? false,
    source: row ? "saved" : "env",
    ...(prev
      ? { previous: { provider: prev.provider, model: prev.model, baseUrl: prev.baseUrl } }
      : {}),
    ...(row?.last_check ? { lastCheck: row.last_check } : {}),
  };
}

export async function viewSettings(deps: Deps) {
  const rows = await deps.db.query<Row>(
    "SELECT role, config, previous, last_check, verified FROM model_settings",
  );
  const byRole = new Map(rows.map((r) => [r.role, r]));
  const roles = Object.fromEntries(
    ROLES.map((r) => [r, view(deps.config[r], byRole.get(r))]),
  ) as Record<Role, RoleView>;
  return { strict_offline: deps.config.strictOffline, roles };
}

export function candidateOf(deps: Deps, role: Role, i: ApplyInput): ProviderConfig {
  const cur = deps.config[role];
  // A key is kept across a model change on the same provider; a new provider needs its own key.
  const apiKey = i.apiKey ?? (cur.provider === i.provider ? cur.apiKey : undefined);
  return {
    provider: i.provider,
    model: i.model,
    ...(i.baseUrl ? { baseUrl: i.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

export async function runCheck(deps: Deps, role: Role, p: ProviderConfig): Promise<CheckResult> {
  const r = await checkProvider(role, p, deps.guard, deps.models.fake);
  await deps.db.query("UPDATE model_settings SET last_check = $2::jsonb WHERE role = $1", [
    role,
    JSON.stringify(r),
  ]);
  return r;
}

function hostOf(p: ProviderConfig): { host: string; port?: string } {
  if (!p.baseUrl) return { host: "api.anthropic.com" };
  const u = new URL(p.baseUrl);
  return { host: u.hostname, port: u.port || undefined };
}

function sameEndpoint(a: ProviderConfig, b: ProviderConfig) {
  return a.provider === b.provider && (a.baseUrl ?? "") === (b.baseUrl ?? "");
}

function needConfirm(required: string[], given: string[], message: string) {
  const missing = required.filter((r) => !given.includes(r));
  if (missing.length) {
    throw Object.assign(new HttpError(409, "confirmation_required", message), {
      required: missing,
    });
  }
}

async function indexedItems(deps: Deps): Promise<number> {
  const [r] = await deps.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM digest_items WHERE embedding IS NOT NULL",
  );
  return r?.n ?? 0;
}

/** Re-embed every stored item with the active embedding model (FR-008). */
export async function reindexEmbeddings(deps: Deps): Promise<number> {
  const rows = await deps.db.query<{
    id: string;
    text: string;
    rationale: string | null;
    alternatives: string[];
  }>("SELECT id, text, rationale, alternatives FROM digest_items");
  for (let i = 0; i < rows.length; i += 64) {
    const batch = rows.slice(i, i + 64);
    const vectors = await embedTexts(
      deps.models.embed,
      batch.map((r) =>
        [r.text, r.rationale, r.alternatives.length ? `Rejected: ${r.alternatives.join("; ")}` : ""]
          .filter(Boolean)
          .join("\n"),
      ),
    );
    for (const [n, r] of batch.entries()) {
      const v = vectors[n];
      if (v)
        await deps.db.query("UPDATE digest_items SET embedding = $2::vector WHERE id = $1", [
          r.id,
          toVector(v),
        ]);
    }
  }
  await deps.db.query("UPDATE workspaces SET embed_model = $1", [deps.config.embed.model]);
  return rows.length;
}

function swap(deps: Deps, role: Role, p: ProviderConfig) {
  deps.config[role] = p;
  // Models are shared by reference; requests holding the object see the new providers.
  Object.assign(deps.models, createModels(deps.config, deps.guard), { fake: deps.models.fake });
}

export async function applySettings(deps: Deps, role: Role, input: ApplyInput) {
  const cand = candidateOf(deps, role, input);
  const cur = deps.config[role];
  const local = isLocal(cand);

  const bad = staticItems(role, cand)[0];
  if (bad) throw new HttpError(422, "invalid_request", `${bad.detail}; ${bad.fix}`);
  if (deps.config.strictOffline && !local) {
    const { host, port } = hostOf(cand);
    if (!deps.guard.isAllowed(host, port)) {
      throw new HttpError(
        422,
        "offline_blocked",
        `strict offline mode is on and ${host} is not a declared host`,
      );
    }
  }
  if (!local && !sameEndpoint(cand, cur)) {
    needConfirm(
      ["data_leaves"],
      input.confirm,
      role === "embed"
        ? "This sends the text of your digest items to a cloud provider."
        : "This sends digest content and questions to a cloud provider; raw transcripts never leave your machine.",
    );
  }
  const embedChanged =
    role === "embed" && (cand.model !== cur.model || cand.provider !== cur.provider);
  if (embedChanged && (await indexedItems(deps)) > 0) {
    needConfirm(
      ["reindex"],
      input.confirm,
      "Changing the embedding model requires re-indexing all stored digest items.",
    );
  }

  const check = await checkProvider(role, cand, deps.guard, deps.models.fake);
  if (check.items.some((i) => i.name === "dimension" && !i.ok)) {
    throw Object.assign(
      new HttpError(422, "incompatible", check.items.find((i) => !i.ok)?.detail ?? "incompatible"),
      { check },
    );
  }
  if (!check.ok && !input.confirm.includes("unverified")) {
    throw Object.assign(
      new HttpError(422, "check_failed", check.items.find((i) => !i.ok)?.detail ?? "check failed"),
      { check },
    );
  }

  await deps.db.query(
    `INSERT INTO model_settings (role, config, previous, last_check, verified, updated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, now())
     ON CONFLICT (role) DO UPDATE SET config = EXCLUDED.config, previous = $3::jsonb,
       last_check = EXCLUDED.last_check, verified = EXCLUDED.verified, updated_at = now()`,
    [
      role,
      JSON.stringify(toStored(deps.config.secret, cand)),
      JSON.stringify(toStored(deps.config.secret, cur)),
      JSON.stringify(check),
      check.ok,
    ],
  );
  swap(deps, role, cand);
  let reindexed: number | undefined;
  if (embedChanged && input.confirm.includes("reindex")) reindexed = await reindexEmbeddings(deps);
  const v = (await viewSettings(deps)).roles[role];
  return { ...v, check, ...(reindexed === undefined ? {} : { reindexed }) };
}

export async function revertSettings(deps: Deps, role: Role) {
  const [row] = await deps.db.query<Row>(
    "SELECT role, config, previous FROM model_settings WHERE role = $1",
    [role],
  );
  if (!row?.previous) throw new HttpError(409, "no_previous", "there is no previous configuration");
  const prev = fromStored(deps.config.secret, row.previous);
  if (deps.config.strictOffline && !isLocal(prev)) {
    const { host, port } = hostOf(prev);
    if (!deps.guard.isAllowed(host, port)) {
      throw new HttpError(
        422,
        "offline_blocked",
        `strict offline mode is on and ${host} is not a declared host`,
      );
    }
  }
  await deps.db.query(
    "UPDATE model_settings SET config = $2::jsonb, previous = $3::jsonb, verified = false, last_check = NULL, updated_at = now() WHERE role = $1",
    [role, JSON.stringify(row.previous), JSON.stringify(row.config)],
  );
  const changedEmbed = role === "embed" && prev.model !== deps.config.embed.model;
  swap(deps, role, prev);
  if (changedEmbed && (await indexedItems(deps)) > 0) await reindexEmbeddings(deps);
  return (await viewSettings(deps)).roles[role];
}
