// Console routes (spec 009). URL-based so pages deep-link and the back button works; the server
// serves console.html for each top-level section (apps/server/src/routes/static.ts).
import { useI18n } from "@pama/i18n";
import { buttonClass, PageHeader } from "@pama/ui";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { Activity as ActivityIcon, House, Library, MessageCircle } from "lucide-react";
import { Audit } from "./Audit.tsx";
import { Bundles } from "./Bundles.tsx";
import { Doctor } from "./Doctor.tsx";
import { Inbox } from "./Inbox.tsx";
import { Links } from "./Links.tsx";
import { Placeholder } from "./Placeholder.tsx";
import { Review } from "./Review.tsx";
import { Settings } from "./Settings.tsx";
import { Shell, SubNav } from "./Shell.tsx";

function NotFound() {
  const { t } = useI18n();
  return (
    <Placeholder
      title="404"
      description=""
      icon={House}
      action={
        <Link to="/review" className={buttonClass("secondary")}>
          {t.nav.review}
        </Link>
      }
    />
  );
}

function HomePage() {
  const { t } = useI18n();
  return (
    <Placeholder
      title={t.pages.home.title}
      description={t.pages.home.description}
      icon={House}
      action={
        <Link to="/review" className={buttonClass("secondary")}>
          {t.nav.review}
        </Link>
      }
    />
  );
}

function ChatPage() {
  const { t } = useI18n();
  return (
    <Placeholder
      title={t.pages.chat.title}
      description={t.pages.chat.description}
      icon={MessageCircle}
    />
  );
}

function LibraryLayout() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t.pages.library.title} description={t.pages.library.description} />
      <SubNav
        items={[
          { to: "/library", label: t.pages.library.title, exact: true },
          { to: "/library/tasks", label: t.nav.tasks },
        ]}
      />
      <Outlet />
    </>
  );
}

function LibraryIndex() {
  const { t } = useI18n();
  return (
    <Placeholder
      header={false}
      title={t.pages.library.title}
      description={t.pages.library.description}
      icon={Library}
      action={
        <Link to="/library/tasks" className={buttonClass("secondary")}>
          {t.nav.tasks}
        </Link>
      }
    />
  );
}

function ActivityLayout() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t.pages.activity.title} description={t.pages.activity.description} />
      <SubNav
        items={[
          { to: "/activity", label: t.pages.activity.title, exact: true },
          { to: "/activity/audit", label: t.nav.audit },
          { to: "/activity/doctor", label: t.nav.doctor },
        ]}
      />
      <Outlet />
    </>
  );
}

function ActivityIndex() {
  const { t } = useI18n();
  return (
    <Placeholder
      header={false}
      title={t.pages.activity.title}
      description={t.pages.activity.description}
      icon={ActivityIcon}
      action={
        <Link to="/activity/doctor" className={buttonClass("secondary")}>
          {t.nav.doctor}
        </Link>
      }
    />
  );
}

export function makeRouter(opts: { dev?: boolean } = {}) {
  const root = createRootRoute({
    component: () => <Shell dev={opts.dev} />,
    notFoundComponent: NotFound,
  });
  const page = (path: string, component: () => React.JSX.Element) =>
    createRoute({ getParentRoute: () => root, path, component });

  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    // Home becomes the default page once it has content (spec 006).
    beforeLoad: () => {
      throw redirect({ to: "/review", replace: true });
    },
  });
  const links = createRoute({
    getParentRoute: () => root,
    path: "/links",
    component: Links,
    validateSearch: (s: Record<string, unknown>): { q?: string; new?: boolean } => ({
      ...(typeof s.q === "string" && s.q ? { q: s.q } : {}),
      ...(s.new === true || s.new === "true" ? { new: true } : {}),
    }),
  });
  const library = page("/library", LibraryLayout);
  const libraryIndex = createRoute({
    getParentRoute: () => library,
    path: "/",
    component: LibraryIndex,
  });
  const tasks = createRoute({ getParentRoute: () => library, path: "tasks", component: Bundles });
  const activity = page("/activity", ActivityLayout);
  const activityIndex = createRoute({
    getParentRoute: () => activity,
    path: "/",
    component: ActivityIndex,
  });
  const audit = createRoute({ getParentRoute: () => activity, path: "audit", component: Audit });
  const doctor = createRoute({ getParentRoute: () => activity, path: "doctor", component: Doctor });
  const settingsIndex = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    beforeLoad: ({ location }) => {
      if (location.pathname.replace(/\/$/, "") === "/settings")
        throw redirect({ to: "/settings/connections", replace: true });
    },
  });
  const connections = createRoute({
    getParentRoute: () => root,
    path: "/settings/connections",
    component: Settings,
    validateSearch: (s: Record<string, unknown>): { section?: "placement" | "models" } =>
      s.section === "models" || s.section === "placement" ? { section: s.section } : {},
  });

  const tree = root.addChildren([
    index,
    page("/home", HomePage),
    page("/review", Review),
    page("/conversations", Inbox),
    links,
    page("/chat", ChatPage),
    library.addChildren([libraryIndex, tasks]),
    activity.addChildren([activityIndex, audit, doctor]),
    settingsIndex,
    connections,
  ]);
  return createRouter({ routeTree: tree, defaultPreload: "intent", scrollRestoration: true });
}
