// Source suggestions for the link creator (FR-009): rank bundles by relevance to a question or
// keywords plus recency; bundles with sensitive labels are flagged and not preselected.
import { embed } from "ai";
import type { Deps } from "../app.ts";
import { toVector } from "./embed.ts";

export interface SuggestedSource {
  ref: { type: "bundle"; id: string };
  title: string;
  project: string;
  score: number;
  sessions: number;
  date_range: { from: string | null; to: string | null };
  flagged_labels: string[];
  preselected: boolean;
}

export async function suggestSources(
  deps: Pick<Deps, "db" | "models" | "workspaceId">,
  query: string,
): Promise<SuggestedSource[]> {
  const { embedding } = await embed({ model: deps.models.embed, value: query });
  const rows = await deps.db.query<{
    bundle_id: string;
    bundle: string;
    project: string;
    best: number;
    sessions: number;
    first: Date | null;
    last: Date | null;
    labels: string[] | null;
  }>(
    `SELECT b.id AS bundle_id, b.name AS bundle, p.name AS project,
            max(1 - (i.embedding <=> $2::vector))::float AS best,
            count(DISTINCT i.session_id)::int AS sessions,
            min(s.ended_at) AS first, max(s.ended_at) AS last,
            array_agg(DISTINCT l) FILTER (WHERE l IS NOT NULL) AS labels
     FROM digest_items i
     JOIN bundles b ON b.id = i.bundle_id JOIN projects p ON p.id = b.project_id
     JOIN sessions s ON s.id = i.session_id
     LEFT JOIN LATERAL unnest(i.labels) AS l ON true
     WHERE i.workspace_id = $1 AND i.active AND i.embedding IS NOT NULL
     GROUP BY b.id, b.name, p.name`,
    [deps.workspaceId, toVector(embedding)],
  );
  const newest = Math.max(...rows.map((r) => (r.last ? new Date(r.last).getTime() : 0)), 1);
  return rows
    .map((r) => {
      const age = r.last ? (newest - new Date(r.last).getTime()) / 86_400_000 : 365;
      const score = 0.85 * Math.max(0, r.best) + 0.15 * Math.exp(-age / 30);
      const flagged = r.labels ?? [];
      return {
        ref: { type: "bundle" as const, id: r.bundle_id },
        title: r.bundle,
        project: r.project,
        score: Math.round(score * 1000) / 1000,
        sessions: r.sessions,
        date_range: {
          from: r.first ? new Date(r.first).toISOString() : null,
          to: r.last ? new Date(r.last).toISOString() : null,
        },
        flagged_labels: flagged,
        preselected: flagged.length === 0 && r.best > 0.15,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}
