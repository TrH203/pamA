// "Live" when the event stream is connected, otherwise says the page refreshes on a timer.
import { useI18n } from "@pama/i18n";
import { StatusPill } from "@pama/ui";
import { Radio, RefreshCw } from "lucide-react";
import { useLive } from "./useEvents.ts";

export function LiveIndicator() {
  const { t } = useI18n();
  const live = useLive();
  return (
    <span aria-live="polite">
      {live ? (
        <StatusPill tone="success" icon={Radio}>
          {t.pipeline.home.live}
        </StatusPill>
      ) : (
        <StatusPill tone="neutral" icon={RefreshCw}>
          {t.pipeline.home.polling}
        </StatusPill>
      )}
    </span>
  );
}
