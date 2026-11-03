// Recent hotkey drafts (spec 008, US4): the popup lists the last drafts the server recorded so the
// owner can reopen one without asking again.
import { useI18n } from "@pama/i18n";
import { EmptyState, ErrorBanner, SkeletonList, StatusPill } from "@pama/ui";
import { History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { draftApi, type RecentDraft } from "./api.ts";

export function RecentDrafts({ onPick }: { onPick: (d: RecentDraft) => void }) {
  const { t } = useI18n();
  const s = t.convo.popup;
  const [items, setItems] = useState<RecentDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setItems(null);
    try {
      setItems((await draftApi.recent()).items);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <ErrorBanner
        title={s.recentFailed}
        message={error}
        onRetry={() => void load()}
        retryLabel={t.common.retry}
      />
    );
  }
  if (!items) return <SkeletonList rows={3} label={t.common.loading} />;
  if (!items.length) return <EmptyState icon={History} title={s.recentEmpty} />;
  return (
    <ul className="space-y-1" aria-label={s.recent}>
      {items.map((d) => (
        <li key={d.ask_id}>
          <button
            type="button"
            aria-label={s.reopen(d.question)}
            onClick={() => onPick(d)}
            className="w-full rounded-control border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="block truncate text-sm font-medium text-fg">{d.question}</span>
            <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
              <StatusPill tone={d.answer ? "success" : "warning"}>
                {t.convo.status[d.answer ? "drafted" : "refused"]}
              </StatusPill>
              <time dateTime={d.created_at}>{new Date(d.created_at).toLocaleString()}</time>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
