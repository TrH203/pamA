// Home (spec 006 UI): pipeline counts, what needs the owner (failed runs, failing doctor checks)
// with direct fixes, recent runs and quick links. The console's landing page.
import { useI18n } from "@pama/i18n";
import {
  buttonClass,
  Card,
  CardHeader,
  cn,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Skeleton,
  SkeletonList,
} from "@pama/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Library,
  Link2,
  Loader,
  type LucideIcon,
  Plus,
  Settings,
  Stethoscope,
} from "lucide-react";
import type { ReactNode } from "react";
import { api, errorMessage } from "../../../lib/api.ts";
import { activityQueries, openFailures, type Run } from "../activity/api.ts";
import { ago, runLabel } from "../activity/format.ts";
import { LiveIndicator } from "../activity/LiveIndicator.tsx";
import { FailureDetails, HintText, RunStatus } from "../activity/parts.tsx";
import { usePollInterval } from "../activity/useEvents.ts";

interface DoctorCheck {
  check: string;
  ok: boolean;
  detail: string;
  fix: string | null;
}

/** Same key as the Doctor page, so both share one report. Cloud servers answer 404: no checks. */
const doctorQuery = {
  queryKey: ["doctor"],
  queryFn: () => api<{ checks: DoctorCheck[] }>("/v1/doctor"),
  retry: false,
  staleTime: 60_000,
} as const;

function Stat({
  label,
  value,
  icon: Icon,
  to,
  search,
  tone,
}: {
  label: string;
  value: number | undefined;
  icon: LucideIcon;
  to: string;
  search?: Record<string, string>;
  tone: "neutral" | "accent" | "danger";
}) {
  const color = {
    neutral: "text-muted",
    accent: "text-accent-ink",
    danger: value ? "text-danger-ink" : "text-muted",
  }[tone];
  return (
    <Link
      to={to}
      search={search}
      className="group flex min-w-0 flex-col gap-1 rounded-control border border-line bg-bg px-3 py-3 transition-colors hover:border-line-strong hover:bg-subtle"
    >
      <span className={cn("flex items-center gap-1.5 text-xs font-medium", color)}>
        <Icon aria-hidden className="size-3.5" />
        {label}
      </span>
      <div className="text-2xl font-semibold tabular-nums tracking-tight text-fg">
        {value ?? <Skeleton className="mt-1 h-7 w-8" />}
      </div>
    </Link>
  );
}

function Attention({
  icon: Icon,
  title,
  children,
  actions,
}: {
  icon: LucideIcon;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="break-words text-ui font-medium text-fg">{title}</p>
        {children}
        {actions && <div className="flex flex-wrap gap-2 pt-0.5">{actions}</div>}
      </div>
    </li>
  );
}

function NeedsAttention({
  failures,
  checks,
  loading,
}: {
  failures: Run[];
  checks: DoctorCheck[];
  loading: boolean;
}) {
  const { t } = useI18n();
  const h = t.pipeline.home;
  const empty = !loading && failures.length === 0 && checks.length === 0;
  return (
    <Card className="p-0 sm:p-0" aria-label={h.needsAttention}>
      <CardHeader className="mb-0 px-4 pt-4 sm:px-5 sm:pt-5" title={h.needsAttention} />
      {loading && <SkeletonList rows={1} label={t.common.loading} className="p-4" />}
      {empty && (
        <div className="p-4">
          <EmptyState icon={CircleCheck} title={h.allClear} description={h.allClearHint} />
        </div>
      )}
      {!loading && !empty && (
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {failures.map((r) => (
            <Attention
              key={r.id}
              icon={CircleAlert}
              title={
                <Link
                  to="/activity/$id"
                  params={{ id: r.id }}
                  className="underline-offset-2 hover:underline"
                >
                  {h.runFailed(runLabel(r))}
                </Link>
              }
            >
              <FailureDetails run={r} compact />
            </Attention>
          ))}
          {checks.map((c) => (
            <Attention
              key={`doctor-${c.check}`}
              icon={Stethoscope}
              title={h.checkFailed(c.check)}
              actions={
                <Link to="/activity/doctor" className={buttonClass("secondary", "sm")}>
                  {h.openDoctor}
                </Link>
              }
            >
              <p className="text-ui text-muted">{c.detail}</p>
              {c.fix && <HintText className="text-ui" text={`→ \`${c.fix}\``} />}
            </Attention>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Recent({ runs }: { runs: Run[] }) {
  const { t, locale } = useI18n();
  const h = t.pipeline.home;
  if (runs.length === 0) {
    return <EmptyState icon={Activity} title={h.recentEmpty} description={h.recentEmptyHint} />;
  }
  return (
    <ul className="-mx-1 divide-y divide-line">
      {runs.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5">
          <Link
            to="/activity/$id"
            params={{ id: r.id }}
            className="min-w-0 flex-1 truncate text-ui font-medium text-fg underline-offset-2 hover:underline"
          >
            {runLabel(r)}
          </Link>
          <RunStatus status={r.status} />
          <time
            dateTime={r.started_at}
            className="w-24 shrink-0 text-right text-xs tabular-nums text-faint"
          >
            {ago(r.started_at, locale)}
          </time>
        </li>
      ))}
    </ul>
  );
}

function QuickLinks() {
  const { t } = useI18n();
  const items: { to: string; label: string; icon: LucideIcon; search?: Record<string, unknown> }[] =
    [
      { to: "/review", label: t.nav.review, icon: ClipboardCheck },
      { to: "/links", label: t.nav.newLink, icon: Plus, search: { new: true } },
      { to: "/links", label: t.nav.links, icon: Link2 },
      { to: "/library/tasks", label: t.nav.tasks, icon: Library },
      { to: "/settings/connections", label: t.nav.connections, icon: Settings },
    ];
  return (
    <nav aria-label={t.pipeline.home.quickLinks}>
      <ul className="space-y-0.5">
        {items.map((i) => (
          <li key={i.label}>
            <Link
              to={i.to}
              search={i.search}
              className="flex h-8 items-center gap-2.5 rounded-control px-2 text-ui text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <i.icon aria-hidden className="size-4 shrink-0" />
              <span className="flex-1 truncate">{i.label}</span>
              <ArrowRight aria-hidden className="size-3.5 text-faint" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Home() {
  const { t } = useI18n();
  const h = t.pipeline.home;
  const poll = usePollInterval();
  const summary = useQuery({ ...activityQueries.summary, refetchInterval: poll });
  const failed = useQuery({ ...activityQueries.failed, refetchInterval: poll });
  const doctor = useQuery(doctorQuery);
  const counts = summary.data?.counts;
  const failures = openFailures(failed.data?.runs ?? [], summary.data?.runs ?? []);
  const checks = (doctor.data?.checks ?? []).filter((c) => !c.ok);

  return (
    <>
      <PageHeader
        title={t.pages.home.title}
        description={t.pages.home.description}
        actions={<LiveIndicator />}
      />
      <div className="space-y-6">
        {summary.isError && (
          <ErrorBanner
            title={t.common.loadFailed}
            message={errorMessage(summary.error)}
            onRetry={() => {
              void summary.refetch();
              void failed.refetch();
            }}
            retryLabel={t.common.retry}
          />
        )}

        <Card aria-label={h.pipeline}>
          <CardHeader
            title={h.pipeline}
            description={h.pipelineHint}
            actions={
              <Link to="/activity" className={buttonClass("ghost", "sm")}>
                {h.viewAll}
                <ArrowRight aria-hidden />
              </Link>
            }
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              label={t.pipeline.stats.running}
              value={counts?.running}
              icon={Loader}
              to="/activity"
              search={{ status: "running" }}
              tone="accent"
            />
            <Stat
              label={t.pipeline.stats.awaitingReview}
              value={counts?.awaiting_review}
              icon={ClipboardCheck}
              to="/review"
              tone="neutral"
            />
            <Stat
              label={t.pipeline.stats.failed}
              value={counts?.failed}
              icon={CircleAlert}
              to="/activity"
              search={{ status: "failed" }}
              tone="danger"
            />
          </div>
        </Card>

        {failed.isError ? (
          !summary.isError && (
            <ErrorBanner
              title={t.common.loadFailed}
              message={errorMessage(failed.error)}
              onRetry={() => void failed.refetch()}
              retryLabel={t.common.retry}
            />
          )
        ) : (
          <NeedsAttention failures={failures} checks={checks} loading={failed.isPending} />
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
          <Card aria-label={h.recent}>
            <CardHeader
              title={h.recent}
              actions={
                <Link to="/activity" className={buttonClass("ghost", "sm")}>
                  {h.viewAll}
                  <ArrowRight aria-hidden />
                </Link>
              }
            />
            {summary.isPending && <SkeletonList rows={2} label={t.common.loading} />}
            {summary.data && <Recent runs={summary.data.runs.slice(0, 6)} />}
          </Card>
          <Card>
            <CardHeader title={h.quickLinks} />
            <QuickLinks />
          </Card>
        </div>
      </div>
    </>
  );
}
