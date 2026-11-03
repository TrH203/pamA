// v0.1 console links used `/?tab=<name>` (the desktop app, docs and emails still do). Map them to
// the v0.2 routes so old bookmarks keep working; other query parameters (q, section) are kept.

export const TAB_PATHS: Record<string, string> = {
  review: "/review",
  links: "/links",
  inbox: "/conversations",
  audit: "/activity/audit",
  bundles: "/library/tasks",
  settings: "/settings/connections",
  doctor: "/activity/doctor",
};

/** The URL to replace the current one with, or null when it is already a v0.2 URL. */
export function legacyRedirect(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const isConsoleRoot = pathname === "/console" || pathname === "/console/";
  if (!tab && !isConsoleRoot) return null;
  if (tab && pathname !== "/" && !isConsoleRoot) return null;
  params.delete("tab");
  const path = tab ? (TAB_PATHS[tab] ?? "/review") : "/";
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}
