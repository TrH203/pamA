// Console routes (spec 009). URL-based so pages deep-link and the back button works; the server
// serves console.html for each top-level section (apps/server/src/routes/static.ts).
import { useI18n } from "@pama/i18n";
import { buttonClass, ErrorBanner } from "@pama/ui";
import {
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  Link,
  redirect,
} from "@tanstack/react-router";
import { House } from "lucide-react";
import { Audit } from "./Audit.tsx";
import { Doctor } from "./Doctor.tsx";
import { Links } from "./Links.tsx";
import { Placeholder } from "./Placeholder.tsx";
import { ActivityLayout } from "./pages/activity/ActivityLayout.tsx";
import { ActivityList, validateActivitySearch } from "./pages/activity/ActivityList.tsx";
import { RunDetail } from "./pages/activity/RunDetail.tsx";
import { ChatPage, chatSearch } from "./pages/chat/ChatPage.tsx";
import { ConversationDetailPage } from "./pages/conversations/ConversationDetail.tsx";
import { ConversationsPage, conversationSearch } from "./pages/conversations/ConversationsPage.tsx";
import { Home } from "./pages/home/Home.tsx";
import { Digests } from "./pages/library/Digests.tsx";
import { LibraryLayout } from "./pages/library/Library.tsx";
import { SearchResults } from "./pages/library/SearchResults.tsx";
import { SessionDetailRoute } from "./pages/library/SessionDetail.tsx";
import { Sessions } from "./pages/library/Sessions.tsx";
import { TaskDetailRoute } from "./pages/library/TaskDetail.tsx";
import { Tasks } from "./pages/library/Tasks.tsx";
import { Review } from "./pages/review/Review.tsx";
import {
  Connections,
  Devices,
  Privacy,
  Publish,
  Retention,
  SettingsLayout,
} from "./pages/settings/index.ts";
import { Shell } from "./Shell.tsx";

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
  // Library (spec 007): Tasks, Sessions, Digests and search; `/library` opens Tasks.
  const library = page("/library", LibraryLayout);
  const libraryIndex = createRoute({
    getParentRoute: () => library,
    path: "/",
    beforeLoad: () => {
      throw redirect({ to: "/library/tasks", replace: true });
    },
  });
  const libChild = (path: string, component: () => React.JSX.Element) =>
    createRoute({ getParentRoute: () => library, path, component });
  const librarySearch = createRoute({
    getParentRoute: () => library,
    path: "search",
    component: SearchResults,
    validateSearch: (s: Record<string, unknown>): { q?: string } =>
      searchText(s.q) !== undefined ? { q: searchText(s.q) } : {},
  });
  const libraryRoutes = [
    libraryIndex,
    libChild("tasks", Tasks),
    libChild("tasks/$id", TaskDetailRoute),
    libChild("sessions", Sessions),
    libChild("sessions/$id", SessionDetailRoute),
    libChild("digests", Digests),
    librarySearch,
  ];
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

  // Conversations and Chat (spec 008); the old Inbox is /conversations?status=needs_reply.
  const conversations = createRoute({
    getParentRoute: () => root,
    path: "/conversations",
    component: ConversationsPage,
    validateSearch: conversationSearch,
  });
  const conversationDetail = createRoute({
    getParentRoute: () => root,
    path: "/conversations/$id",
    component: ConversationDetailPage,
  });
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/chat",
    component: ChatPage,
    validateSearch: chatSearch,
  });

  const tree = root.addChildren([
    index,
    homeAlias,
    page("/review", Review),
    conversations,
    conversationDetail,
    links,
    chat,
    library.addChildren(libraryRoutes),
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
