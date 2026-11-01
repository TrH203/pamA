// Settings → Connections: one tab per question the owner asks. "Where things run" answers what
// is local and what is online; "Models" chooses the providers (including OpenRouter). The full
// Connections page (data home, agents, devices) is spec 005.
import { useI18n } from "@pama/i18n";
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@pama/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Models } from "./Models.tsx";
import { Placement } from "./Placement.tsx";

type Section = "placement" | "models";

export function Settings() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { section?: Section };
  const section: Section = search.section === "models" ? "models" : "placement";
  return (
    <>
      <PageHeader title={t.pages.settings.title} description={t.pages.settings.description} />
      <Tabs
        value={section}
        onValueChange={(v) =>
          void navigate({
            to: "/settings/connections",
            search: { section: v as Section },
            replace: true,
          })
        }
      >
        <TabsList aria-label={t.nav.connections}>
          <TabsTrigger value="placement">{t.pages.settings.placement}</TabsTrigger>
          <TabsTrigger value="models">{t.pages.settings.models}</TabsTrigger>
        </TabsList>
        <TabsContent value="placement">
          <Placement />
        </TabsContent>
        <TabsContent value="models">
          <Models />
        </TabsContent>
      </Tabs>
    </>
  );
}
