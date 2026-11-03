// Library search (GET /v1/search?q=): approved digest items, grouped by task.
import { useI18n } from "@pama/i18n";
import { Badge, Card, CardHeader, EmptyState, Notice } from "@pama/ui";
import { Link, useSearch } from "@tanstack/react-router";
import { Info, Search, SearchX } from "lucide-react";
import { type SearchHit, useSearchLibrary } from "./data.ts";
import { QueryView, useFormatDate } from "./parts.tsx";

interface Group {
  bundleId: string;
  bundle: string;
  project: string | null;
  hits: SearchHit[];
}

/** Groups hits by task, keeping the order of each task's best hit. */
export function groupByTask(items: SearchHit[]): Group[] {
  const groups = new Map<string, Group>();
  for (const h of items) {
    let g = groups.get(h.bundle_id);
    if (!g) {
      g = { bundleId: h.bundle_id, bundle: h.bundle, project: h.project, hits: [] };
      groups.set(h.bundle_id, g);
    }
    g.hits.push(h);
  }
  return [...groups.values()];
}

export function SearchResults() {
  const { t } = useI18n();
  const l = t.lib.library;
  const fmt = useFormatDate();
  const { q = "" } = useSearch({ strict: false }) as { q?: string };
  const query = useSearchLibrary(q);

  if (!q.trim())
    return <EmptyState icon={Search} title={l.searchStart} description={l.searchStartHint} />;

  return (
    <section aria-label={l.tabs.search} className="space-y-4">
      <QueryView
        query={query}
        isEmpty={(d) => d.items.length === 0}
        empty={{ icon: SearchX, title: l.searchEmpty, description: l.searchEmptyHint }}
      >
        {(d) => (
          <>
            <p className="text-ui text-muted" aria-live="polite">
              {l.results(d.items.length)}
            </p>
            {d.mode === "text" && (
              <Notice icon={Info} tone="neutral">
                {l.searchTextOnly}
              </Notice>
            )}
            {groupByTask(d.items).map((g) => (
              <Card key={g.bundleId}>
                <CardHeader
                  title={
                    <Link
                      to={`/library/tasks/${g.bundleId}`}
                      className="rounded-control hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {g.bundle}
                    </Link>
                  }
                  description={g.project ?? undefined}
                />
                <ul className="divide-y divide-line">
                  {g.hits.map((h) => (
                    <li key={h.id} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="accent">{l.kinds[h.kind] ?? h.kind}</Badge>
                        <Link
                          to={`/library/sessions/${h.session_id}`}
                          className="text-xs text-muted hover:underline"
                        >
                          {l.version(h.digest_version)} · {fmt(h.ended_at)}
                        </Link>
                      </div>
                      <p className="text-ui text-fg">{h.text}</p>
                      {h.rationale && <p className="text-ui text-muted">{h.rationale}</p>}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </>
        )}
      </QueryView>
    </section>
  );
}
