// Console routes (spec 009). URL-based so pages deep-link and the back button works; the server
// serves console.html for each top-level section (apps/server/src/routes/static.ts).
import { useI18n } from "@pama/i18n";
import { buttonClass, ErrorBanner, PageHeader } from "@pama/ui";
import {
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  Link,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { House, Library, MessageCircle } from "lucide-react";
import { Audit } from "./Audit.tsx";
import { Bundles } from "./Bundles.tsx";
import { Doctor } from "./Doctor.tsx";
import { Inbox } from "./Inbox.tsx";
import { Links } from "./Links.tsx";
import { Placeholder } from "./Placeholder.tsx";
import { ActivityLayout } from "./pages/activity/ActivityLayout.tsx";
import { ActivityList, validateActivitySearch } from "./pages/activity/ActivityList.tsx";
import { RunDetail } from "./pages/activity/RunDetail.tsx";
import { Home } from "./pages/home/Home.tsx";
import {
  Connections,
  Devices,
  Privacy,
  Publish,
  Retention,
  SettingsLayout,
} from "./pages/settings/index.ts";
import { Review } from "./Review.tsx";
import { Shell, SubNav } from "./Shell.tsx";

/** A page that threw while rendering: keep the shell and offer a retry instead of a bare trace. */
function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useI18n();
  return (
    <ErrorBanner
      title={t.common.loadFailed}
      message={error instanceof Error ? error.message : String(error)}
      onRetry={reset}
      retryLabel={t.common.retry}
    />
  );
}

function NotFound() {
  const { t } = useI18n();
  return (
    <Placeholder
      title="404"
      description=""
      icon={House}
      action={
        <Link to="/" className={buttonClass("secondary")}>
          {t.nav.home}
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
        label={t.pages.library.title}
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

/** A search param as text: the router JSON-parses values, so `?q=123` arrives as a number. */
export function searchText(v: unknown): string | undefined {
  if (typeof v === "string") return v || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

export function makeRouter(opts: { dev?: boolean } = {}) {
  const root = createRootRoute({
    component: () => <Shell dev={opts.dev} />,
    notFoundComponent: NotFound,
  });
  const page = (path: string, component: () => React.JSX.Element) =>
    createRoute({ getParentRoute: () => root, path, component });

  // Home is the landing page (spec 006); `/home` stays as an alias for old links.
  const index = page("/", Home);
  const homeAlias = createRoute({
    getParentRoute: () => root,
    path: "/home",
    beforeLoad: () => {
      throw redirect({ to: "/", replace: true });
    },
  });
  const links = createRoute({
    getParentRoute: () => root,
    path: "/links",
    component: Links,
    validateSearch: (s: Record<string, unknown>): { q?: string; new?: boolean } => ({
      ...(searchText(s.q) !== undefined ? { q: searchText(s.q) } : {}),
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
    component: ActivityList,
    validateSearch: validateActivitySearch,
  });
  const runDetail = createRoute({
    getParentRoute: () => activity,
    path: "$id",
    component: RunDetail,
  });
  const audit = createRoute({ getParentRoute: () => activity, path: "audit", component: Audit });
  const doctor = createRoute({ getParentRoute: () => activity, path: "doctor", component: Doctor });
  // Settings (spec 005/007/008): a layout with one URL per sub-page; /settings opens Connections.
  const settings = page("/settings", SettingsLayout);
  const settingsIndex = createRoute({
    getParentRoute: () => settings,
    path: "/",
    beforeLoad: () => {
      throw redirect({ to: "/settings/connections", replace: true });
    },
  });
  const settingsPages = [
    createRoute({ getParentRoute: () => settings, path: "connections", component: Connections }),
    createRoute({ getParentRoute: () => settings, path: "devices", component: Devices }),
    createRoute({ getParentRoute: () => settings, path: "publish", component: Publish }),
    createRoute({ getParentRoute: () => settings, path: "privacy", component: Privacy }),
    createRoute({ getParentRoute: () => settings, path: "retention", component: Retention }),
  ];

  const tree = root.addChildren([
    index,
    homeAlias,
    page("/review", Review),
    page("/conversations", Inbox),
    links,
    page("/chat", ChatPage),
    library.addChildren([libraryIndex, tasks]),
    activity.addChildren([activityIndex, audit, doctor, runDetail]),
    settings.addChildren([settingsIndex, ...settingsPages]),
  ]);
  return createRouter({
    routeTree: tree,
    defaultPreload: "intent",
    defaultErrorComponent: RouteError,
    scrollRestoration: true,
  });
}
