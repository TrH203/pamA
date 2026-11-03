// Activity → one run: stage timeline, the coded error with its fix, Retry, and where the logs are.
import { useI18n } from "@pama/i18n";
import { buttonClass, Card, CardHeader, EmptyState, ErrorBanner, Skeleton } from "@pama/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, SearchX } from "lucide-react";
import { errorMessage, isApiError } from "../../../lib/api.ts";
import { activityQueries, digestQuery } from "./api.ts";
import { absolute, ago, duration, runLabel, timeline } from "./format.ts";
import { FailureDetails, HintText, RunStatus, StageTimeline } from "./parts.tsx";
import { usePollInterval } from "./useEvents.ts";

function Back() {
  const { t } = useI18n();
  return (
    <Link to="/activity" className={buttonClass("ghost", "sm")}>
      <ArrowLeft aria-hidden />
      {t.pipeline.activity.back}
    </Link>
  );
}

export function RunDetail() {
  const { t, locale } = useI18n();
  const a = t.pipeline.activity;
  const { id } = useParams({ strict: false }) as { id: string };
  const poll = usePollInterval();
  const q = useQuery({
    ...activityQueries.run(id),
    // Poll an in-flight run when the stream is down; a finished run does not change on its own.
    refetchInterval: (query) => {
      const s = query.state.data?.run.status;
      return s === "running" || s === "queued" ? poll : false;
    },
  });
  const run = q.data?.run;
  const digest = useQuery({
    ...digestQuery(run?.digest_id ?? ""),
    enabled: !!run?.digest_id,
    retry: false,
  });

  if (q.isPending) {
    return (
      <div role="status" aria-label={t.common.loading} className="space-y-4">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (q.isError) {
    if (isApiError(q.error, 404)) {
      return (
        <EmptyState
          icon={SearchX}
          title={a.notFound}
          description={a.notFoundHint}
          action={<Back />}
        />
      );
    }
    return (
      <div className="space-y-3">
        <Back />
        <ErrorBanner
          title={t.common.loadFailed}
          message={errorMessage(q.error)}
          onRetry={() => void q.refetch()}
          retryLabel={t.common.retry}
        />
      </div>
    );
  }
  if (!run) return null;

  const meta: [string, string][] = [
    [a.started, absolute(run.started_at, locale)],
    [a.duration, duration(run.duration_ms)],
    [a.attempts, a.attemptsN(run.attempts)],
    [a.stage, t.pipeline.stages[run.stage] ?? run.stage],
  ];

  return (
    <article className="space-y-4" aria-labelledby="run-title">
      <Back />
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="run-title" className="min-w-0 break-words text-base font-semibold text-fg">
          {runLabel(run)}
        </h2>
        <RunStatus status={run.status} />
        <span className="text-xs text-faint">
          {a.kind[run.kind] ?? run.kind} · {ago(run.updated_at, locale)}
        </span>
      </header>

      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <Card>
          <CardHeader title={a.timeline} />
          <StageTimeline steps={timeline(run, digest.data)} />
        </Card>

        <div className="min-w-0 space-y-4">
          {run.status === "failed" && (
            <Card className="border-danger/30">
              <CardHeader title={a.error} />
              <FailureDetails run={run} />
            </Card>
          )}

          <Card>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-ui sm:grid-cols-4">
              {meta.map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="truncate text-fg">{v}</dd>
                </div>
              ))}
            </dl>
            {run.digest_id && (
              <p className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-ui">
                <span className="text-muted">{a.digest}:</span>
                <code className="font-mono text-xs">{run.digest_id}</code>
                {digest.data?.status === "draft" && (
                  <Link to="/review" className={buttonClass("secondary", "sm")}>
                    {a.openReview}
                  </Link>
                )}
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title={a.logs} />
            <p className="text-ui text-muted">
              <HintText text={`${a.logsHint} \`pama logs server --follow\``} />
            </p>
            <p className="mt-1 font-mono text-xs text-faint">run {run.id}</p>
          </Card>
        </div>
      </div>
    </article>
  );
}
