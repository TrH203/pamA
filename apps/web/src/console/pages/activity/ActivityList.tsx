// Activity → runs: every digest request with its stage, status and error, filterable by status
// and start time. Rows open the run detail (/activity/:id).
import { useI18n } from "@pama/i18n";
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Select,
  SkeletonList,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@pama/ui";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { errorMessage } from "../../../lib/api.ts";
import {
  activityQueries,
  type RunFilter,
  type RunStatus,
  SINCE,
  type Since,
  STATUSES,
} from "./api.ts";
import { absolute, ago, duration, runLabel } from "./format.ts";
import { RunStatus as StatusOf } from "./parts.tsx";
import { usePollInterval } from "./useEvents.ts";

export function validateActivitySearch(s: Record<string, unknown>): RunFilter {
  const out: RunFilter = {};
  if (typeof s.status === "string" && (STATUSES as string[]).includes(s.status))
    out.status = s.status as RunStatus;
  if (typeof s.since === "string" && (SINCE as readonly string[]).includes(s.since))
    out.since = s.since as Since;
  return out;
}

export function ActivityList() {
  const { t, locale } = useI18n();
  const a = t.pipeline.activity;
  const filter = useSearch({ strict: false }) as RunFilter;
  const navigate = useNavigate();
  const poll = usePollInterval();
  const runs = useInfiniteQuery({
    ...activityQueries.list(filter),
    refetchInterval: poll,
    // Keep the table while a new filter loads instead of flashing a skeleton.
    placeholderData: keepPreviousData,
  });
  const setFilter = (next: RunFilter) =>
    void navigate({ to: "/activity", search: validateActivitySearch({ ...filter, ...next }) });
  const filtered = !!(filter.status || filter.since);
  const rows = runs.data?.pages.flatMap((p) => p.runs) ?? [];

  return (
    <section className="space-y-4" aria-label={t.pages.activity.title}>
      <fieldset className="flex flex-wrap items-end gap-3">
        <legend className="sr-only">{a.filters}</legend>
        <Field label={a.status} className="w-40">
          <Select
            value={filter.status ?? ""}
            onChange={(e) => setFilter({ status: (e.target.value || undefined) as RunStatus })}
          >
            <option value="">{a.all}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.pipeline.statuses[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={a.since} className="w-44">
          <Select
            value={filter.since ?? ""}
            onChange={(e) => setFilter({ since: (e.target.value || undefined) as Since })}
          >
            <option value="">{a.sinceOptions.all}</option>
            {SINCE.map((s) => (
              <option key={s} value={s}>
                {a.sinceOptions[s]}
              </option>
            ))}
          </Select>
        </Field>
        {filtered && (
          <Button variant="ghost" onClick={() => void navigate({ to: "/activity", search: {} })}>
            {a.clearFilters}
          </Button>
        )}
      </fieldset>

      {runs.isPending && <SkeletonList rows={3} label={t.common.loading} />}
      {runs.isError && (
        <ErrorBanner
          title={t.common.loadFailed}
          message={errorMessage(runs.error)}
          onRetry={() => void runs.refetch()}
          retryLabel={t.common.retry}
        />
      )}
      {runs.isSuccess && rows.length === 0 && (
        <EmptyState
          icon={Activity}
          title={filtered ? a.emptyFiltered : a.empty}
          description={filtered ? undefined : a.emptyHint}
          action={
            filtered ? (
              <Button onClick={() => void navigate({ to: "/activity", search: {} })}>
                {a.clearFilters}
              </Button>
            ) : undefined
          }
        />
      )}
      {rows.length > 0 && (
        <Table label={a.table}>
          <THead>
            <tr>
              <TH>{a.started}</TH>
              <TH>{a.session}</TH>
              <TH>{a.stage}</TH>
              <TH>{a.status}</TH>
              <TH className="text-right">{a.duration}</TH>
              <TH className="text-right">{a.attempts}</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD className="whitespace-nowrap text-muted">
                  <time dateTime={r.started_at} title={absolute(r.started_at, locale)}>
                    {ago(r.started_at, locale)}
                  </time>
                </TD>
                <TD className="min-w-48">
                  <Link
                    to="/activity/$id"
                    params={{ id: r.id }}
                    aria-label={a.open(runLabel(r))}
                    className="font-medium text-fg underline-offset-2 hover:underline"
                  >
                    {runLabel(r)}
                  </Link>
                  {r.status === "failed" && r.error_code && (
                    <div className="mt-0.5 font-mono text-xs text-danger-ink">{r.error_code}</div>
                  )}
                </TD>
                <TD className="whitespace-nowrap text-muted">
                  {t.pipeline.stages[r.stage] ?? r.stage}
                </TD>
                <TD>
                  <StatusOf status={r.status} />
                </TD>
                <TD className="whitespace-nowrap text-right tabular-nums text-muted">
                  {duration(r.duration_ms)}
                </TD>
                <TD className="text-right tabular-nums text-muted">{r.attempts}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {runs.hasNextPage && (
        <div className="flex justify-center">
          <Button loading={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
            {a.loadMore}
          </Button>
        </div>
      )}
    </section>
  );
}
