/** Pure formatting for the bundle summary shown by the console and the desktop settings. */

export const MAX_CHIPS = 3;

export interface BundleLike {
  name: string;
  key?: string | null;
  branches: string[];
  session_count: number;
  last_activity: string | null;
}

export interface BundleSummaryView {
  title: string;
  chips: string[];
  overflow: number;
  allBranches: string[];
  sessionsLabel: string;
  lastActivityLabel: string | null;
}

/** "just now", "30 min ago", "3 h ago", "2 d ago", else the UTC date. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const s = (now.getTime() - at.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return at.toISOString().slice(0, 10);
}

export function summarizeBundle(b: BundleLike, now: Date = new Date()): BundleSummaryView {
  return {
    title: b.name.trim() || b.key || "Untitled bundle",
    chips: b.branches.slice(0, MAX_CHIPS),
    overflow: Math.max(0, b.branches.length - MAX_CHIPS),
    allBranches: b.branches,
    sessionsLabel: b.session_count === 1 ? "1 session" : `${b.session_count} sessions`,
    lastActivityLabel: b.last_activity ? relativeTime(b.last_activity, now) : null,
  };
}
