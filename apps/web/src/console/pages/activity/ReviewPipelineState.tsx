// Review's empty state, told from the real pipeline: "2 sessions are being drafted",
// "1 session failed · View". Falls back to the plain hint when nothing is in flight.
import { useI18n } from "@pama/i18n";
import { buttonClass, EmptyState } from "@pama/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import { activityQueries } from "./api.ts";
import { usePollInterval } from "./useEvents.ts";

export function ReviewPipelineState() {
  const { t } = useI18n();
  const poll = usePollInterval();
  const q = useQuery({ ...activityQueries.summary, refetchInterval: poll });
  const c = q.data?.counts;
  const lines: string[] = [];
  if (c?.running) lines.push(t.pipeline.review.drafting(c.running));
  if (c?.failed) lines.push(t.pipeline.review.failed(c.failed));
  return (
    <EmptyState
      icon={ClipboardCheck}
      title={t.pages.review.empty}
      description={lines.length ? lines.join(" · ") : t.pages.review.emptyHint}
      action={
        c?.failed ? (
          <Link
            to="/activity"
            search={{ status: "failed" }}
            className={buttonClass("secondary", "sm")}
          >
            {t.pipeline.review.view}
          </Link>
        ) : c?.running ? (
          <Link
            to="/activity"
            search={{ status: "running" }}
            className={buttonClass("ghost", "sm")}
          >
            {t.pipeline.review.view}
          </Link>
        ) : undefined
      }
    />
  );
}
