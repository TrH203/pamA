import { ulid } from "ulid";
import type { Queryable } from "../db/client.ts";

export interface ProjectRow {
  id: string;
  name: string;
  repo_key: string;
  auto_approve: boolean | null;
  sync_enabled: boolean;
  sync_target: string | null;
}

export async function upsertProject(
  q: Queryable,
  workspaceId: string,
  repoKey: string,
  name?: string,
): Promise<ProjectRow> {
  const [existing] = await q.query<ProjectRow>(
    "SELECT id, name, repo_key, auto_approve, sync_enabled, sync_target FROM projects WHERE workspace_id = $1 AND repo_key = $2",
    [workspaceId, repoKey],
  );
  if (existing) return existing;
  const fallback = repoKey.split(/[/:]/).filter(Boolean).at(-1) ?? repoKey;
  const [row] = await q.query<ProjectRow>(
    `INSERT INTO projects (id, workspace_id, name, repo_key) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, repo_key) DO UPDATE SET repo_key = excluded.repo_key
     RETURNING id, name, repo_key, auto_approve, sync_enabled, sync_target`,
    [ulid(), workspaceId, name ?? fallback.replace(/\.git$/, ""), repoKey],
  );
  return row as ProjectRow;
}

/** project.auto_approve when set, else the workspace default. */
export async function autoApproveFor(q: Queryable, projectId: string): Promise<boolean> {
  const [r] = await q.query<{ auto: boolean }>(
    `SELECT COALESCE(p.auto_approve, w.auto_approve) AS auto
     FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = $1`,
    [projectId],
  );
  return r?.auto ?? false;
}
