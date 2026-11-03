// Small pieces the Library pages share: agent and status pills, dates, filters and paging.
import { useI18n } from "@pama/i18n";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Select,
  SkeletonList,
  StatusPill,
  type Tone,
} from "@pama/ui";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  Ban,
  Bot,
  CircleCheck,
  CircleDashed,
  FilePen,
  GitBranch,
  History,
  type LucideIcon,
  Undo2,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { errorMessage } from "../../../lib/api.ts";

export function AgentBadge({ agent }: { agent: string }) {
  const { t } = useI18n();
  return (
    <Badge tone="neutral">
      <Bot aria-hidden />
      {t.lib.agents[agent] ?? agent.replace(/_/g, " ")}
    </Badge>
  );
}

const STATUS: Record<string, { tone: Tone; icon: LucideIcon }> = {
  draft: { tone: "warning", icon: FilePen },
  approved: { tone: "success", icon: CircleCheck },
  discarded: { tone: "neutral", icon: Ban },
  withdrawn: { tone: "neutral", icon: Undo2 },
  superseded: { tone: "neutral", icon: History },
  none: { tone: "neutral", icon: CircleDashed },
};

/** A digest or session status: icon + text, never colour alone. `null` means no digest yet. */
export function DigestStatusPill({ status }: { status: string | null }) {
  const { t } = useI18n();
  const key = status ?? "none";
  const s = STATUS[key] ?? { tone: "neutral" as Tone, icon: CircleDashed };
  return (
    <StatusPill tone={s.tone} icon={s.icon}>
      {t.lib.status[key] ?? key}
    </StatusPill>
  );
}

export function BranchChips({ branches, max = 4 }: { branches: string[]; max?: number }) {
  const { t } = useI18n();
  if (!branches.length) return <span className="text-xs text-faint">{t.lib.library.noBranch}</span>;
  const shown = branches.slice(0, max);
  const rest = branches.length - shown.length;
  return (
    <ul className="flex flex-wrap gap-1" aria-label={t.lib.library.branches}>
      {shown.map((b) => (
        <li key={b}>
          <Badge tone="accent" className="max-w-56 font-mono" title={b}>
            <GitBranch aria-hidden />
            <span className="truncate">{b}</span>
          </Badge>
        </li>
      ))}
      {rest > 0 && (
        <li>
          <Badge title={branches.slice(max).join(", ")}>+{rest}</Badge>
        </li>
      )}
    </ul>
  );
}

export function useFormatDate() {
  const { locale } = useI18n();
  return (iso: string | null | undefined, withTime = true) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return withTime
      ? d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
      : d.toLocaleDateString(locale, { dateStyle: "medium" });
  };
}

/** Loading, error (with retry) and empty states around a query; renders children with data. */
export function QueryView<T>({
  query,
  isEmpty,
  empty,
  children,
  rows,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  empty: {
    icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
  };
  children: (data: T) => ReactNode;
  rows?: number;
}) {
  const { t } = useI18n();
  if (query.isPending) return <SkeletonList rows={rows} label={t.common.loading} />;
  if (query.isError)
    return (
      <ErrorBanner
        title={t.common.loadFailed}
        message={errorMessage(query.error)}
        onRetry={() => void query.refetch()}
        retryLabel={t.common.retry}
      />
    );
  if (isEmpty?.(query.data)) return <EmptyState {...empty} />;
  return <>{children(query.data)}</>;
}

export function FilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  options: { value: string; label: string }[];
}) {
  return (
    <Field label={label} className="min-w-40 flex-1 sm:max-w-56">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function Pager({
  offset,
  count,
  total,
  limit,
  onOffset,
}: {
  offset: number;
  count: number;
  total: number;
  limit: number;
  onOffset: (o: number) => void;
}) {
  const { t } = useI18n();
  const l = t.lib.library;
  if (total <= limit && offset === 0) return null;
  return (
    <nav
      aria-label={l.pagination}
      className="flex flex-wrap items-center justify-end gap-2 text-ui"
    >
      <span className="mr-auto text-muted tabular-nums" aria-live="polite">
        {l.showing(count ? offset + 1 : 0, offset + count, total)}
      </span>
      <Button
        size="sm"
        disabled={offset === 0}
        onClick={() => onOffset(Math.max(0, offset - limit))}
      >
        {l.previous}
      </Button>
      <Button size="sm" disabled={offset + count >= total} onClick={() => onOffset(offset + limit)}>
        {l.next}
      </Button>
    </nav>
  );
}
