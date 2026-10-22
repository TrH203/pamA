// resolveLink(slug) → the scope and policy of one Ask Link (data-model.md, Scope enforcement).
// Sources are resolved to session ids at query time, so new sessions of a linked project or
// bundle are covered and removed ones disappear.
import type { Queryable } from "../db/client.ts";
import { HttpError } from "../http.ts";

export interface SourceRef {
  type: "project" | "bundle" | "session";
  id: string;
}

export interface ResolvedLink {
  slug: string;
  workspaceId: string;
  title: string;
  status: "active" | "degraded";
  allowedSessionIds: string[];
  denyLabels: string[];
  denyTopics: string[];
  detail: "headline" | "summary" | "technical";
  instruction: string | null;
  accessMode: "open" | "pin" | "email_otp" | "allowlist";
  pinHash: string | null;
  allowlist: string[];
  rateLimitPerHour: number;
  ownerName: string;
  footerEnabled: boolean;
  expiresAt: Date;
}

export const INACTIVE = () => new HttpError(410, "link_inactive", "This link is no longer active.");

interface LinkRow {
  slug: string;
  workspace_id: string;
  title: string;
  source_refs: SourceRef[];
  detail: ResolvedLink["detail"];
  deny_labels: string[];
  deny_topics: string[];
  instruction: string | null;
  access_mode: ResolvedLink["accessMode"];
  pin_hash: string | null;
  allowlist: string[];
  rate_limit_per_hour: number;
  expires_at: Date;
  revoked_at: Date | null;
  footer_enabled: boolean;
  default_deny_labels: string[];
  display_name: string;
}

export async function resolveLink(q: Queryable, slug: string): Promise<ResolvedLink> {
  const [l] = await q.query<LinkRow>(
    `SELECT l.*, w.default_deny_labels, w.display_name
     FROM ask_links l JOIN workspaces w ON w.id = l.workspace_id WHERE l.slug = $1`,
    [slug],
  );
  if (!l) throw new HttpError(404, "not_found", "No such link.");
  if (l.revoked_at || new Date(l.expires_at).getTime() <= Date.now()) throw INACTIVE();

  const ids = (t: SourceRef["type"]) => l.source_refs.filter((r) => r.type === t).map((r) => r.id);
  const rows = await q.query<{ id: string; project_id: string; bundle_id: string }>(
    `SELECT id, project_id, bundle_id FROM sessions
     WHERE workspace_id = $1 AND (project_id = ANY($2) OR bundle_id = ANY($3) OR id = ANY($4))`,
    [l.workspace_id, ids("project"), ids("bundle"), ids("session")],
  );
  const found = (r: SourceRef) =>
    rows.some((s) =>
      r.type === "project"
        ? s.project_id === r.id
        : r.type === "bundle"
          ? s.bundle_id === r.id
          : s.id === r.id,
    );
  const missing = l.source_refs.filter((r) => !found(r));
  if (missing.length === l.source_refs.length) throw INACTIVE();

  return {
    slug: l.slug,
    workspaceId: l.workspace_id,
    title: l.title,
    status: missing.length ? "degraded" : "active",
    allowedSessionIds: rows.map((r) => r.id),
    denyLabels: [...new Set([...l.deny_labels, ...l.default_deny_labels])],
    denyTopics: l.deny_topics,
    detail: l.detail,
    instruction: l.instruction,
    accessMode: l.access_mode,
    pinHash: l.pin_hash,
    allowlist: l.allowlist,
    rateLimitPerHour: l.rate_limit_per_hour,
    ownerName: l.display_name,
    footerEnabled: l.footer_enabled,
    expiresAt: l.expires_at,
  };
}
