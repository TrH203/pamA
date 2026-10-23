// Per-link hourly question limit (FR-018) and a per-visitor share of it.
import type { Queryable } from "../db/client.ts";
import { HttpError } from "../http.ts";

/** One visitor may use at most this share of a link's hourly budget (at least 5 questions). */
export const VISITOR_SHARE = 0.5;

export async function checkAskRate(q: Queryable, slug: string, visitorId: string, perHour: number) {
  const [r] = await q.query<{ link: number; visitor: number }>(
    `SELECT count(*)::int AS link, count(*) FILTER (WHERE visitor_id = $2)::int AS visitor
     FROM asks WHERE link_slug = $1 AND created_at > now() - interval '1 hour'`,
    [slug, visitorId],
  );
  const perVisitor = Math.max(5, Math.floor(perHour * VISITOR_SHARE));
  if ((r?.link ?? 0) >= perHour || ((r?.visitor ?? 0) >= perVisitor && perVisitor < perHour)) {
    throw new HttpError(429, "rate_limited", "Too many questions for now. Please try again later.");
  }
}
