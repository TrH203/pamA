// Audit retention (spec Assumptions): asks older than the retention period are deleted, together
// with visitors that no longer have asks or access to an active link. Default 180 days.
import type { Queryable } from "../db/client.ts";

export const DEFAULT_RETENTION_DAYS = 180;

export async function applyRetention(q: Queryable, days = DEFAULT_RETENTION_DAYS) {
  const asks = await q.query<{ id: string }>(
    "DELETE FROM asks WHERE created_at < now() - make_interval(days => $1) RETURNING id",
    [days],
  );
  const visitors = await q.query<{ id: string }>(
    `DELETE FROM visitors v WHERE v.created_at < now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.visitor_id = v.id)
     RETURNING id`,
    [days],
  );
  return { asks: asks.length, visitors: visitors.length };
}
