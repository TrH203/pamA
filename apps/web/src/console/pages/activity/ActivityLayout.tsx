// Activity section: runs (index), run detail, and the Audit log and Doctor tabs.
import { useI18n } from "@pama/i18n";
import { PageHeader } from "@pama/ui";
import { Outlet } from "@tanstack/react-router";
import { SubNav } from "../../Shell.tsx";
import { LiveIndicator } from "./LiveIndicator.tsx";

export function ActivityLayout() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader
        title={t.pages.activity.title}
        description={t.pages.activity.description}
        actions={<LiveIndicator />}
      />
      <SubNav
        label={t.pages.activity.title}
        items={[
          { to: "/activity", label: t.pipeline.activity.table, exact: true },
          { to: "/activity/audit", label: t.nav.audit },
          { to: "/activity/doctor", label: t.nav.doctor },
        ]}
      />
      <Outlet />
    </>
  );
}
