// Audit retention (spec Assumptions; spec 008b makes it a workspace setting): asks and
// conversations older than the workspace's `ask_retention_days` (default 180) are deleted, together
// with visitors that no longer have asks or access to an active link. Conversations deleted by
// the owner or the asker are purged here, as are empty conversations older than a day.
import type { Queryable } from "../db/client.ts";

export const DEFAULT_RETENTION_DAYS = 180;

/** Days for a workspace: the override when given (tests, operators), else the setting. */
const DAYS = (ws: string) =>
  `COALESCE($1::int, (SELECT w.ask_retention_days FROM workspaces w WHERE w.id = ${ws}), ${DEFAULT_RETENTION_DAYS})`;

export async function applyRetention(q: Queryable, days?: number) {
  const override = days ?? null;
  const conversations = await q.query<{ id: string }>(
    `DELETE FROM conversations c
     WHERE c.deleted_at IS NOT NULL
        OR c.last_at < now() - make_interval(days => ${DAYS("c.workspace_id")})
        OR (c.last_at < now() - interval '1 day'
            AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.conversation_id = c.id))
     RETURNING id`,
    [override],
  );
  const asks = await q.query<{ id: string }>(
    `DELETE FROM asks a WHERE a.created_at < now() - make_interval(days => ${DAYS("a.workspace_id")})
     RETURNING id`,
    [override],
  );
  const visitors = await q.query<{ id: string }>(
    `DELETE FROM visitors v
     WHERE v.created_at < now() - make_interval(days => COALESCE($1::int,
             (SELECT w.ask_retention_days FROM ask_links l JOIN workspaces w ON w.id = l.workspace_id
              WHERE l.slug = v.link_slug), ${DEFAULT_RETENTION_DAYS}))
       AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.visitor_id = v.id)
     RETURNING id`,
    [override],
  );
  return { asks: asks.length, conversations: conversations.length, visitors: visitors.length };
}
