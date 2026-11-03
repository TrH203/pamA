// Settings section: page title and the sub-pages (Connections, Devices, Publish or Sharing,
// Privacy, Retention). Each sub-page is its own URL so it deep-links and the back button works.
import { useI18n } from "@pama/i18n";
import { PageHeader } from "@pama/ui";
import { Outlet } from "@tanstack/react-router";
import { SubNav } from "../../Shell.tsx";
import { useMe } from "./data.ts";

export const SETTINGS_PAGES = [
  "connections",
  "devices",
  "publish",
  "privacy",
  "retention",
] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

export function SettingsLayout() {
  const { t } = useI18n();
  const s = t.pages.settings;
  // Publish is the local-mode one-way copy; on a server the same page shows what was shared.
  const mode = useMe().data?.mode;
  const local = mode !== "cloud" && mode !== "selfhost";
  return (
    <>
      <PageHeader title={s.title} description={s.description} />
      <SubNav
        label={s.title}
        items={SETTINGS_PAGES.map((p) => ({
          to: `/settings/${p}`,
          label: p === "publish" && !local ? s.nav.sharing : s.nav[p],
        }))}
      />
      <Outlet />
    </>
  );
}
