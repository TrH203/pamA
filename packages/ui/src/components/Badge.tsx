import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn.ts";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "bg-subtle text-muted border-line",
  accent: "bg-accent-soft text-accent-ink border-transparent",
  success: "bg-success-soft text-success-ink border-transparent",
  warning: "bg-warning-soft text-warning-ink border-transparent",
  danger: "bg-danger-soft text-danger-ink border-transparent",
};

/** A small label. Use StatusPill for states, so they never rely on colour alone. */
export function Badge({
  tone = "neutral",
  className,
  children,
  title,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-xs font-medium",
        "[&_svg]:size-3",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_ICON: Record<Tone, LucideIcon> = {
  neutral: CircleDashed,
  accent: CircleDot,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

/** A status: icon + text + tint. The icon and text carry the meaning; colour only reinforces. */
export function StatusPill({
  tone,
  children,
  icon,
  className,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  icon?: LucideIcon | null;
  className?: string;
  title?: string;
}) {
  const Icon = icon === null ? null : (icon ?? STATUS_ICON[tone]);
  return (
    <Badge tone={tone} className={className} title={title}>
      {Icon && <Icon aria-hidden strokeWidth={2.25} />}
      {children}
    </Badge>
  );
}

/** Count bubble for nav items ("3 waiting"). Hidden when zero or unknown. */
export function CountBadge({
  count,
  tone = "neutral",
  label,
}: {
  count: number | null | undefined;
  tone?: Tone;
  label?: string;
}) {
  if (!count) return null;
  return (
    <span
      className={cn(
        "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium tabular-nums",
        TONE[tone],
      )}
    >
      <span aria-hidden>{count > 99 ? "99+" : count}</span>
      <span className="sr-only">{label ?? String(count)}</span>
    </span>
  );
}
