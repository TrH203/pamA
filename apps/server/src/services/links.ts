// Ask Links (FR-008/009/010/016): create with validated sources and settings, list, update,
// revoke. Defaults: 7 days, summary, PIN, 30 questions per hour (spec Assumptions).
import { randomBytes, randomInt } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { ACCESS_MODES, DETAIL_LEVELS } from "../db/schema/links.ts";
import { HttpError } from "../http.ts";
import { suggestQuestions } from "../pipeline/suggest-questions.ts";
import { resolveLink } from "../policy/resolve-link.ts";
import { scopedItems } from "../policy/scoped-repo.ts";
import { hashSecret } from "../policy/secrets.ts";
import { SensitivityLabelSchema } from "../schema/digest.ts";

const DAY = 86_400_000;
export const MAX_EXPIRY_DAYS = 90;

export const SourceRefSchema = z.strictObject({
  type: z.enum(["project", "bundle", "session"]),
  id: z.string().min(1).max(64),
});

const duration = z
  .string()
  .regex(/^\d+[hd]$/)
  .transform((s) => Number.parseInt(s, 10) * (s.endsWith("h") ? 3_600_000 : DAY));

export const LinkInputSchema = z.strictObject({
  title: z.string().min(1).max(200).optional(),
  sources: z.array(SourceRefSchema).min(1).max(50),
  expires: duration.optional(),
  detail: z.enum(DETAIL_LEVELS).default("summary"),
  deny_labels: z.array(SensitivityLabelSchema).default([]),
  deny_topics: z.array(z.string().min(1).max(100)).max(30).default([]),
  instruction: z.string().max(2000).optional(),
  access_mode: z.enum(ACCESS_MODES).default("pin"),
  pin: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
  allowlist: z
    .array(z.string().regex(/^(\*@[^@\s]+\.[^@\s]+|[^@\s]+@[^@\s]+\.[^@\s]+)$/))
    .max(200)
    .default([]),
  rate_limit_per_hour: z.int().min(1).max(500).default(30),
  suggested_questions: z.array(z.string().min(1).max(200)).max(5).optional(),
  footer_enabled: z.boolean().default(true),
});
export type LinkInput = z.input<typeof LinkInputSchema>;

type LinkDeps = Pick<Deps, "db" | "models" | "workspaceId" | "config" | "mailer">;

function slug(): string {
  // 10 base32 characters = 50 random bits.
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return [...randomBytes(10)].map((b) => alphabet[b & 31]).join("");
}

async function validateSources(deps: LinkDeps, sources: z.infer<typeof SourceRefSchema>[]) {
  for (const r of sources) {
    const col =
      r.type === "project" ? "project_id" : r.type === "bundle" ? "bundle_id" : "session_id";
    const [ok] = await deps.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM digest_items WHERE workspace_id = $1 AND ${col} = $2 AND active`,
      [deps.workspaceId, r.id],
    );
    if (!ok?.n) {
      throw new HttpError(
        422,
        "invalid_source",
        `${r.type} ${r.id} has no approved digests in this workspace`,
      );
    }
  }
}

async function titleFor(
  deps: LinkDeps,
  sources: z.infer<typeof SourceRefSchema>[],
): Promise<string> {
  const r = sources[0];
  if (!r) return "Ask about my work";
  const table = r.type === "project" ? "projects" : r.type === "bundle" ? "bundles" : null;
  if (!table) return "Ask about my work";
  const [row] = await deps.db.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [
    r.id,
  ]);
  return row?.name ?? "Ask about my work";
}

export async function setSuggestedQuestions(
  deps: Pick<Deps, "db">,
  link: string,
  questions: string[],
  edited: boolean,
) {
  await deps.db.tx(async (q) => {
    await q.query("DELETE FROM suggested_questions WHERE link_slug = $1", [link]);
    for (const [rank, text] of questions.entries()) {
      await q.query(
        "INSERT INTO suggested_questions (id, link_slug, text, rank, edited_by_owner) VALUES ($1, $2, $3, $4, $5)",
        [ulid(), link, text, rank, edited],
      );
    }
  });
}

export async function createLink(deps: LinkDeps, raw: LinkInput) {
  const parsed = LinkInputSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, "invalid_request", parsed.error.message);
  const input = parsed.data;
  await validateSources(deps, input.sources);
  if (
    (input.access_mode === "email_otp" || input.access_mode === "allowlist") &&
    !deps.mailer.available
  ) {
    throw new HttpError(
      422,
      "email_unavailable",
      "Email access needs a mail server; use open or PIN access.",
    );
  }
  if (input.access_mode === "allowlist" && !input.allowlist.length) {
    throw new HttpError(
      422,
      "invalid_request",
      "allowlist access needs at least one email or *@domain",
    );
  }
  const expiresMs = Math.min(input.expires ?? 7 * DAY, MAX_EXPIRY_DAYS * DAY);
  const pin =
    input.access_mode === "pin"
      ? (input.pin ?? String(randomInt(0, 1_000_000)).padStart(6, "0"))
      : undefined;
  const s = slug();
  await deps.db.query(
    `INSERT INTO ask_links (slug, workspace_id, title, source_refs, detail, deny_labels, deny_topics, instruction,
       access_mode, pin_hash, allowlist, rate_limit_per_hour, expires_at, footer_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      s,
      deps.workspaceId,
      input.title ?? (await titleFor(deps, input.sources)),
      JSON.stringify(input.sources),
      input.detail,
      input.deny_labels,
      input.deny_topics,
      input.instruction ?? null,
      input.access_mode,
      pin ? hashSecret(pin) : null,
      input.allowlist.map((a) => a.toLowerCase()),
      input.rate_limit_per_hour,
      new Date(Date.now() + expiresMs).toISOString(),
      input.footer_enabled,
    ],
  );
  let questions = input.suggested_questions;
  if (!questions) {
    const link = await resolveLink(deps.db, s);
    const items = await scopedItems(
      deps.db,
      {
        workspaceId: deps.workspaceId,
        sessionIds: link.allowedSessionIds,
        denyLabels: link.denyLabels,
      },
      { k: 30 },
    );
    questions = await suggestQuestions(deps.models.small, items).catch(() => []);
  }
  await setSuggestedQuestions(deps, s, questions, Boolean(input.suggested_questions));
  return {
    slug: s,
    url: `${deps.config.baseUrl}/a/${s}`,
    ...(pin && !input.pin ? { pin } : {}),
    suggested_questions: questions,
  };
}

export async function revokeLink(deps: Pick<Deps, "db" | "workspaceId">, s: string) {
  const rows = await deps.db.query(
    "UPDATE ask_links SET revoked_at = COALESCE(revoked_at, now()) WHERE slug = $1 AND workspace_id = $2 RETURNING slug",
    [s, deps.workspaceId],
  );
  if (!rows.length) throw new HttpError(404, "not_found", "link not found");
}

export const LinkPatchSchema = z.strictObject({
  title: z.string().min(1).max(200).optional(),
  expires: duration.optional(),
  detail: z.enum(DETAIL_LEVELS).optional(),
  deny_labels: z.array(SensitivityLabelSchema).optional(),
  deny_topics: z.array(z.string().min(1).max(100)).max(30).optional(),
  instruction: z.string().max(2000).nullable().optional(),
  rate_limit_per_hour: z.int().min(1).max(500).optional(),
  suggested_questions: z.array(z.string().min(1).max(200)).max(5).optional(),
});

export async function patchLink(
  deps: Pick<Deps, "db" | "workspaceId">,
  s: string,
  p: z.infer<typeof LinkPatchSchema>,
) {
  const sets: string[] = [];
  const vals: unknown[] = [s, deps.workspaceId];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (p.title !== undefined) set("title", p.title);
  if (p.expires !== undefined)
    set(
      "expires_at",
      new Date(Date.now() + Math.min(p.expires, MAX_EXPIRY_DAYS * DAY)).toISOString(),
    );
  if (p.detail !== undefined) set("detail", p.detail);
  if (p.deny_labels !== undefined) set("deny_labels", p.deny_labels);
  if (p.deny_topics !== undefined) set("deny_topics", p.deny_topics);
  if (p.instruction !== undefined) set("instruction", p.instruction);
  if (p.rate_limit_per_hour !== undefined) set("rate_limit_per_hour", p.rate_limit_per_hour);
  if (sets.length) {
    const rows = await deps.db.query(
      `UPDATE ask_links SET ${sets.join(", ")} WHERE slug = $1 AND workspace_id = $2 RETURNING slug`,
      vals,
    );
    if (!rows.length) throw new HttpError(404, "not_found", "link not found");
  }
  if (p.suggested_questions) await setSuggestedQuestions(deps, s, p.suggested_questions, true);
}

export async function listLinks(deps: Pick<Deps, "db" | "workspaceId">) {
  return deps.db.query(
    `SELECT l.slug, l.title, l.access_mode, l.detail, l.expires_at, l.revoked_at, l.created_at, l.source_refs,
            CASE WHEN l.revoked_at IS NOT NULL THEN 'revoked' WHEN l.expires_at <= now() THEN 'expired' ELSE 'active' END AS status,
            (SELECT count(*)::int FROM asks a WHERE a.link_slug = l.slug) AS asks
     FROM ask_links l WHERE l.workspace_id = $1 ORDER BY l.created_at DESC`,
    [deps.workspaceId],
  );
}
