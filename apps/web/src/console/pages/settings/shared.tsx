// Small pieces shared by the Settings pages: a copyable terminal command, localized times and the
// loading / error states every page shows the same way.
import { type Locale, useI18n } from "@pama/i18n";
import { Button, ErrorBanner, SkeletonList } from "@pama/ui";
import type { UseQueryResult } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { errorMessage } from "../../../lib/api.ts";

/** A command to run in a terminal, with a copy button (the CLI does what the web cannot). */
export function CopyCommand({ command, hint }: { command: string; hint?: ReactNode }) {
  const { t } = useI18n();
  const s = t.pages.settings;
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <div className="space-y-1.5">
      {hint && <p className="text-ui text-muted">{hint}</p>}
      <div className="flex items-stretch gap-2">
        <code className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap rounded-control border border-line bg-subtle px-3 py-1.5 font-mono text-xs text-fg">
          {command}
        </code>
        <Button size="sm" variant="secondary" onClick={copy} aria-label={`${s.copy}: ${command}`}>
          {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
          {state === "copied" ? s.copied : s.copy}
        </Button>
      </div>
      <p aria-live="polite" className="text-xs text-muted">
        {state === "failed" ? s.copyFailed : ""}
      </p>
    </div>
  );
}

/** "3 min ago" in the viewer's language; an absolute date after a month. */
export function relative(iso: string, locale: Locale, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const s = (at.getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(Math.round(s), "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 30 * 86_400) return rtf.format(Math.round(s / 86_400), "day");
  return at.toLocaleDateString(locale);
}

export function clock(iso: string, locale: Locale): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Loading and error states for one or more queries: a skeleton until every query has data, an
 * error banner with retry when any fails, then the page.
 */
export function Loaded({
  queries,
  rows,
  children,
}: {
  queries: UseQueryResult[];
  rows?: number;
  children: () => ReactNode;
}) {
  const { t } = useI18n();
  const failed = queries.find((q) => q.isError);
  if (failed)
    return (
      <ErrorBanner
        title={t.common.loadFailed}
        message={errorMessage(failed.error)}
        onRetry={() => {
          for (const q of queries) if (q.isError) void q.refetch();
        }}
        retryLabel={t.common.retry}
      />
    );
  if (queries.some((q) => q.data === undefined))
    return <SkeletonList rows={rows} label={t.common.loading} />;
  return <>{children()}</>;
}
