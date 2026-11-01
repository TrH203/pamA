// Pages of the v0.2 information architecture whose content other specs (006–008) deliver.
import { useI18n } from "@pama/i18n";
import { EmptyState, PageHeader } from "@pama/ui";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function Placeholder({
  title,
  description,
  icon,
  action,
  header = true,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  action?: ReactNode;
  /** False inside a section layout that already shows the page title. */
  header?: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      {header && <PageHeader title={title} description={description} />}
      <EmptyState
        icon={icon}
        title={t.common.comingSoon}
        description={t.common.comingSoonHint}
        action={action}
      />
    </>
  );
}
