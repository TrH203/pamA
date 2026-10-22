// The only way to read digest items for an answer (Constitution II). Every query
//   1. runs as the non-superuser role pama_app with the scope in transaction-local settings,
//      so the RLS policy on digest_items applies (research R4), and
//   2. repeats the same filter in SQL, so a missing policy can never widen the scope.
import type { Db, Queryable } from "../db/client.ts";
import { toVector } from "../pipeline/embed.ts";

export interface Scope {
  workspaceId: string;
  sessionIds: string[];
  denyLabels: string[];
}

export interface ScopedItem {
  id: string;
  digest_id: string;
  digest_version: number;
  session_id: string;
  bundle_id: string;
  bundle: string;
  kind: string;
  text: string;
  rationale: string | null;
  alternatives: string[];
  labels: string[];
  ended_at: Date | null;
  /** Retrieval score (higher is better); `similarity` is the cosine similarity when embedded. */
  score: number;
  similarity: number | null;
}

const csv = (xs: string[]) => xs.map((x) => x.replaceAll(",", "")).join(",");

/** Run `fn` with the scope applied at the database level. */
export function withScope<T>(db: Db, scope: Scope, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.tx(async (q) => {
    await q.query(
      "SELECT set_config('pama.allowed_session_ids', $1, true), set_config('pama.deny_labels', $2, true)",
      [csv(scope.sessionIds), csv(scope.denyLabels)],
    );
    await q.exec("SET LOCAL ROLE pama_app");
    return fn(q);
  });
}

const FILTER = `i.workspace_id = $1 AND i.session_id = ANY($2) AND i.active AND NOT (i.labels && $3::text[])`;
const COLUMNS = `i.id, i.digest_id, d.version AS digest_version, i.session_id, i.bundle_id, b.name AS bundle,
  i.kind, i.text, i.rationale, i.alternatives, i.labels, s.ended_at`;
const JOINS = `FROM digest_items i JOIN digests d ON d.id = i.digest_id JOIN sessions s ON s.id = i.session_id
  JOIN bundles b ON b.id = i.bundle_id`;

/**
 * Hybrid retrieval inside the scope: cosine similarity on embeddings plus Postgres full-text,
 * merged with reciprocal rank fusion.
 */
export async function scopedItems(
  db: Db,
  scope: Scope,
  opts: { embedding?: number[]; text?: string; k?: number },
): Promise<ScopedItem[]> {
  if (!scope.sessionIds.length) return [];
  const k = opts.k ?? 8;
  const base = [scope.workspaceId, scope.sessionIds, scope.denyLabels];
  return withScope(db, scope, async (q) => {
    const ranked = new Map<string, { item: ScopedItem; score: number }>();
    const add = (rows: ScopedItem[]) =>
      rows.forEach((r, rank) => {
        const prev = ranked.get(r.id);
        const score = 1 / (60 + rank);
        ranked.set(r.id, {
          item: { ...r, similarity: r.similarity ?? prev?.item.similarity ?? null },
          score: (prev?.score ?? 0) + score,
        });
      });
    if (opts.embedding) {
      add(
        await q.query<ScopedItem>(
          `SELECT ${COLUMNS}, 1 - (i.embedding <=> $4::vector) AS similarity ${JOINS}
           WHERE ${FILTER} AND i.embedding IS NOT NULL
           ORDER BY i.embedding <=> $4::vector LIMIT 20`,
          [...base, toVector(opts.embedding)],
        ),
      );
    }
    if (opts.text?.trim()) {
      add(
        await q.query<ScopedItem>(
          `SELECT ${COLUMNS}, NULL::float AS similarity ${JOINS}
           WHERE ${FILTER} AND i.tsv @@ websearch_to_tsquery('simple', $4)
           ORDER BY ts_rank(i.tsv, websearch_to_tsquery('simple', $4)) DESC LIMIT 20`,
          [...base, opts.text],
        ),
      );
      // OR-match fallback: questions rarely contain every word of an item.
      const words = [...new Set(opts.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(
        0,
        20,
      );
      if (words.length) {
        add(
          await q.query<ScopedItem>(
            `SELECT ${COLUMNS}, NULL::float AS similarity ${JOINS}
             WHERE ${FILTER} AND i.tsv @@ to_tsquery('simple', $4)
             ORDER BY ts_rank(i.tsv, to_tsquery('simple', $4)) DESC LIMIT 20`,
            [
              ...base,
              words
                .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
                .filter(Boolean)
                .join(" | "),
            ],
          ),
        );
      }
    }
    if (!opts.embedding && !opts.text?.trim()) {
      add(
        await q.query<ScopedItem>(
          `SELECT ${COLUMNS}, NULL::float AS similarity ${JOINS} WHERE ${FILTER} ORDER BY i.id LIMIT 200`,
          base,
        ),
      );
    }
    return [...ranked.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ item, score }) => ({ ...item, score }));
  });
}
