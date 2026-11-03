import { Bot } from "lucide-react";

/** Label shown on every automated answer (FR-014, Constitution III). */
export function AutomatedBadge({ owner, label }: { owner: string; label?: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-warning-soft px-2 text-xs font-medium text-warning-ink">
      <Bot aria-hidden className="size-3" />
      {label ?? `Automated answer on behalf of ${owner}`}
    </span>
  );
}
