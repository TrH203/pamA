import { CircleAlert, RotateCw } from "lucide-react";
import type { ComponentType, HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn.ts";
import { Button } from "./Button.tsx";

/** Surface with a hairline border. No heavy shadow: shadows are for popovers and dialogs. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn("rounded-card border border-line bg-surface p-4 sm:p-5", className)}
      {...rest}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-3 flex flex-wrap items-start gap-x-3 gap-y-1", className)}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {description && <p className="text-ui text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Page title row: one h1, an optional one-line explanation and actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-end gap-x-4 gap-y-2", className)}>
      <div className="min-w-0 flex-1 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="max-w-prose text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** What to show when a list is empty: an icon, one sentence and, when it helps, an action. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line-strong px-6 py-10 text-center",
        className,
      )}
    >
      {Icon && (
        <span className="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <Icon aria-hidden className="size-5" />
        </span>
      )}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="max-w-sm text-ui text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Placeholder block while content loads. Decorative: pair it with an accessible busy state. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse rounded-control bg-subtle motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/** A few skeleton rows for a loading list, announced once to screen readers. */
export function SkeletonList({
  rows = 3,
  label = "Loading",
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn("space-y-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="space-y-2 rounded-card border border-line bg-surface p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/** An error the user can act on: what went wrong and a retry button. */
export function ErrorBanner({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Retry",
  className,
}: {
  title?: ReactNode;
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-card border border-danger/30 bg-danger-soft px-4 py-3 text-danger-ink",
        className,
      )}
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-ui font-medium">{title}</p>
        {message && <p className="break-words text-ui opacity-90">{message}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RotateCw aria-hidden />
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

/** A soft inline note (warning, success or neutral) that is not an error. */
export function Notice({
  tone = "neutral",
  children,
  className,
  icon: Icon,
}: {
  tone?: "neutral" | "accent" | "success" | "warning";
  children: ReactNode;
  className?: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}) {
  const tones = {
    neutral: "bg-subtle text-muted border-line",
    accent: "bg-accent-soft text-accent-ink border-transparent",
    success: "bg-success-soft text-success-ink border-transparent",
    warning: "bg-warning-soft text-warning-ink border-transparent",
  };
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-control border px-3 py-2 text-ui",
        tones[tone],
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
