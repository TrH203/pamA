// Building blocks shared by Home and Activity: status pill, retry button, stage timeline, error.
import { useI18n } from "@pama/i18n";
import { Button, buttonClass, cn, Notice, StatusPill, useToast } from "@pama/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  type LucideIcon,
  RotateCw,
  Settings,
  Terminal,
} from "lucide-react";
import { ApiError, errorMessage } from "../../../lib/api.ts";
import { newerRunId, type Run, useRetryRun } from "./api.ts";
import { hintFor, isConfigError, STATUS_TONE, type Step, type StepState } from "./format.ts";

export function RunStatus({ status }: { status: Run["status"] }) {
  const { t } = useI18n();
  return (
    <StatusPill tone={STATUS_TONE[status]}>{t.pipeline.statuses[status] ?? status}</StatusPill>
  );
}

/** Retry a failed run on the server. 409s become a plain explanation, not a stack of errors. */
export function RetryButton({
  run,
  size = "sm",
  variant = "secondary",
}: {
  run: Pick<Run, "id" | "status" | "resumable">;
  size?: "sm" | "md";
  variant?: "primary" | "secondary";
}) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const retry = useRetryRun();
  if (run.status !== "failed" || !run.resumable) return null;
  const onClick = () =>
    retry.mutate(run.id, {
      onSuccess: () => toast.success(t.pipeline.activity.retried),
      onError: (e) => {
        if (e instanceof ApiError && e.status === 409 && e.code === "superseded") {
          const newer = newerRunId(e.message);
          toast.error(
            t.pipeline.activity.superseded,
            newer ? (
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => void navigate({ to: "/activity/$id", params: { id: newer } })}
              >
                {t.pipeline.activity.viewNewer}
              </button>
            ) : undefined,
          );
        } else if (e instanceof ApiError && e.status === 409 && e.code === "conflict") {
          toast.error(t.pipeline.activity.retryFailed, t.pipeline.activity.conflict);
        } else {
          toast.error(t.pipeline.activity.retryFailed, errorMessage(e));
        }
      },
    });
  return (
    <Button size={size} variant={variant} loading={retry.isPending} onClick={onClick}>
      {!retry.isPending && <RotateCw aria-hidden />}
      {t.pipeline.activity.retry}
    </Button>
  );
}

/** Inline code in hint strings: `pama init` → <code>. */
export function HintText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(`[^`]+`)/);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <code key={i} className="rounded bg-subtle px-1 py-0.5 font-mono text-xs text-fg">
            {p.slice(1, -1)}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

/** The coded error with its message, the fix, and direct actions. */
export function FailureDetails({ run, compact = false }: { run: Run; compact?: boolean }) {
  const { t } = useI18n();
  const a = t.pipeline.activity;
  const who = [run.role, run.provider, run.model].filter(Boolean).join(" · ");
  return (
    <div className="space-y-2 text-ui">
      <p className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-danger-soft px-1.5 py-0.5 font-mono text-xs text-danger-ink">
          {run.error_code ?? "internal"}
        </code>
        {who && (
          <span className="text-muted">
            <span className="sr-only">{a.who}: </span>
            {who}
          </span>
        )}
      </p>
      {run.error_message && <p className="break-words text-fg">{run.error_message}</p>}
      <p className="text-muted">
        <span className="font-medium text-fg">{a.fix}: </span>
        <HintText text={hintFor(run.error_code, t)} />
      </p>
      {!compact && !run.resumable && run.status === "failed" && (
        <Notice icon={Terminal}>
          <HintText text={`${a.onDevice} \`pama activity retry --all-failed\``} />
        </Notice>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <RetryButton run={run} />
        {isConfigError(run.error_code) && (
          <Link to="/settings/connections" className={buttonClass("secondary", "sm")}>
            <Settings aria-hidden />
            {t.pipeline.home.openSettings}
          </Link>
        )}
      </div>
    </div>
  );
}

const STEP_ICON: Record<StepState, LucideIcon> = {
  done: CircleCheck,
  failed: CircleAlert,
  current: CircleDot,
  pending: CircleDashed,
  skipped: CircleMinus,
};
const STEP_COLOR: Record<StepState, string> = {
  done: "text-success",
  failed: "text-danger",
  current: "text-accent",
  pending: "text-faint",
  skipped: "text-faint",
};

/** Vertical stage timeline; each step names its state in text, not only by colour. */
export function StageTimeline({ steps }: { steps: Step[] }) {
  const { t } = useI18n();
  const p = t.pipeline;
  return (
    <ol className="space-y-0" aria-label={p.activity.timeline}>
      {steps.map((s, i) => {
        const Icon = STEP_ICON[s.state];
        const last = i === steps.length - 1;
        return (
          <li
            key={s.key}
            aria-current={s.state === "current" ? "step" : undefined}
            className="relative flex gap-3 pb-3 last:pb-0"
          >
            {!last && (
              <span
                aria-hidden
                className="absolute left-[7px] top-5 h-[calc(100%-1rem)] w-px bg-line"
              />
            )}
            <Icon
              aria-hidden
              className={cn(
                "relative mt-0.5 size-4 shrink-0 bg-surface",
                STEP_COLOR[s.state],
                s.state === "current" && "motion-safe:animate-pulse",
              )}
            />
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
              <span
                className={cn(
                  "text-ui",
                  s.state === "pending" || s.state === "skipped" ? "text-muted" : "text-fg",
                  s.state === "failed" && "font-medium text-danger-ink",
                )}
              >
                {p.stages[s.key] ?? s.key}
              </span>
              <span className="text-xs text-faint">{p.stageStates[s.state]}</span>
              {s.device && i === 0 && (
                <span className="w-full text-xs text-faint">{p.activity.deviceStages}</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
