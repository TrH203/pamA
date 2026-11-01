// Console app shell (spec 009): collapsible sidebar with the v0.2 information architecture,
// count badges, Cmd+K palette, language and theme switches in the footer.
import { LOCALES, type Locale, useI18n } from "@pama/i18n";
import {
  Badge,
  Button,
  type CommandItem,
  CommandPalette,
  CountBadge,
  cn,
  Dialog,
  DialogContent,
  type ThemeChoice,
  Tooltip,
  useCommandShortcut,
  useTheme,
} from "@pama/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  ClipboardCheck,
  House,
  Library,
  Link2,
  type LucideIcon,
  Menu,
  MessageCircle,
  MessagesSquare,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { queries } from "../lib/query.ts";

type NavKey =
  | "home"
  | "review"
  | "conversations"
  | "links"
  | "chat"
  | "library"
  | "activity"
  | "settings";

export const NAV: { key: NavKey; to: string; icon: LucideIcon }[] = [
  { key: "home", to: "/home", icon: House },
  { key: "review", to: "/review", icon: ClipboardCheck },
  { key: "conversations", to: "/conversations", icon: MessagesSquare },
  { key: "links", to: "/links", icon: Link2 },
  { key: "chat", to: "/chat", icon: MessageCircle },
  { key: "library", to: "/library", icon: Library },
  { key: "activity", to: "/activity", icon: Activity },
  { key: "settings", to: "/settings/connections", icon: Settings },
];

const COLLAPSE_KEY = "pama.sidebar.collapsed";
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Counts for the nav badges. Missing endpoints or errors simply hide the badge. */
function useCounts(): Partial<Record<NavKey, number>> {
  const review = useQuery({ ...queries.review, refetchInterval: 60_000 });
  const inbox = useQuery({ ...queries.inbox, refetchInterval: 60_000 });
  return {
    review: review.data?.items.length,
    conversations: inbox.data?.items.length,
  };
}

function sectionOf(pathname: string): string {
  return `/${pathname.split("/")[1] ?? ""}`;
}

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  const counts = useCounts();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = sectionOf(pathname);
  return (
    <ul className="space-y-0.5">
      {NAV.map(({ key, to, icon: Icon }) => {
        const label = t.nav[key];
        const active = sectionOf(to) === current;
        const count = counts[key];
        const link = (
          <Link
            to={to}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            aria-label={collapsed ? label : undefined}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-control px-2.5 text-ui font-medium transition-colors duration-150",
              active ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-hover hover:text-fg",
              collapsed && "justify-center px-0",
            )}
          >
            <Icon aria-hidden className="size-4 shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
            {!collapsed && (
              <CountBadge
                count={count}
                tone={active ? "accent" : "neutral"}
                label={t.nav.waiting(count ?? 0)}
              />
            )}
            {collapsed && !!count && <span className="sr-only">{t.nav.waiting(count)}</span>}
          </Link>
        );
        return (
          <li key={key} className="relative">
            {collapsed ? (
              <Tooltip side="right" content={count ? `${label} · ${count}` : label}>
                {link}
              </Tooltip>
            ) : (
              link
            )}
            {collapsed && !!count && (
              <span
                aria-hidden
                className="pointer-events-none absolute right-1.5 top-1 size-1.5 rounded-full bg-accent"
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

const THEME_ICON: Record<ThemeChoice, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };
const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

function FooterControls({ collapsed }: { collapsed: boolean }) {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useTheme();
  const ThemeIcon = THEME_ICON[theme];
  const next = LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length] as Locale;
  return (
    <div className={cn("flex gap-1", collapsed ? "flex-col items-center" : "items-center")}>
      <Tooltip content={`${t.common.theme}: ${t.common.themes[theme]}`}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${t.nav.toggleTheme} (${t.common.themes[theme]})`}
          onClick={() => setTheme(NEXT_THEME[theme])}
        >
          <ThemeIcon aria-hidden />
        </Button>
      </Tooltip>
      <Tooltip content={t.nav.switchLanguage}>
        <Button
          variant="ghost"
          size={collapsed ? "icon" : "sm"}
          aria-label={`${t.common.language}: ${t.common.languages[locale]}. ${t.nav.switchLanguage}`}
          onClick={() => setLocale(next)}
          className="font-mono uppercase"
        >
          {locale}
        </Button>
      </Tooltip>
    </div>
  );
}

function SearchButton({ collapsed, onOpen }: { collapsed: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t.nav.commandPalette}
      aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-control border border-line bg-surface px-2.5 text-ui text-faint transition-colors hover:border-line-strong hover:text-muted",
        collapsed && "justify-center px-0",
      )}
    >
      <Search aria-hidden className="size-4 shrink-0" />
      {!collapsed && <span className="flex-1 truncate text-left">{t.nav.commandPalette}</span>}
      {!collapsed && <kbd className="text-xs">{mac ? "⌘K" : "Ctrl K"}</kbd>}
    </button>
  );
}

function Brand({ dev }: { dev: boolean }) {
  const { t } = useI18n();
  return (
    <Link to="/review" className="flex items-center gap-2 rounded-control px-1 text-fg">
      <span
        aria-hidden
        className="inline-flex size-7 items-center justify-center rounded-control bg-accent text-sm font-semibold text-accent-contrast"
      >
        p
      </span>
      <span className="text-sm font-semibold tracking-tight">pamA</span>
      {dev && <Badge tone="warning">{t.nav.dev}</Badge>}
    </Link>
  );
}

export function Shell({ dev = false, children }: { dev?: boolean; children?: ReactNode }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const togglePalette = useCallback(() => setPaletteOpen((o) => !o), []);
  useCommandShortcut(togglePalette);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [collapsed]);

  const commands: CommandItem[] = [
    ...NAV.map(({ key, to, icon }) => ({
      id: `go-${key}`,
      label: t.nav[key],
      group: t.nav.goTo,
      icon,
      run: () => void navigate({ to }),
    })),
    {
      id: "go-tasks",
      label: t.nav.tasks,
      group: t.nav.goTo,
      icon: Library,
      keywords: ["bundles"],
      run: () => void navigate({ to: "/library/tasks" }),
    },
    {
      id: "go-audit",
      label: t.nav.audit,
      group: t.nav.goTo,
      icon: Activity,
      run: () => void navigate({ to: "/activity/audit" }),
    },
    {
      id: "go-doctor",
      label: t.nav.doctor,
      group: t.nav.goTo,
      icon: Activity,
      run: () => void navigate({ to: "/activity/doctor" }),
    },
    {
      id: "new-link",
      label: t.nav.newLink,
      group: t.nav.actions,
      icon: Plus,
      run: () => void navigate({ to: "/links", search: { new: true } }),
    },
  ];

  return (
    <div className="flex min-h-screen bg-bg text-fg">
      <aside
        aria-label={t.nav.main}
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col gap-4 border-r border-line bg-bg p-3 transition-[width] duration-200 ease-out md:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-between")}>
          {!collapsed && <Brand dev={dev} />}
          <Tooltip side="right" content={collapsed ? t.nav.expand : t.nav.collapse}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={collapsed ? t.nav.expand : t.nav.collapse}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((c) => !c)}
            >
              {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            </Button>
          </Tooltip>
        </div>
        <SearchButton collapsed={collapsed} onOpen={() => setPaletteOpen(true)} />
        <nav aria-label={t.nav.main} className="min-h-0 flex-1 overflow-y-auto">
          <NavList collapsed={collapsed} />
        </nav>
        <FooterControls collapsed={collapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-bg px-4 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.nav.openMenu}
            onClick={() => setMobileOpen(true)}
          >
            <Menu aria-hidden />
          </Button>
          <Brand dev={dev} />
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            aria-label={t.nav.commandPalette}
            onClick={() => setPaletteOpen(true)}
          >
            <Search aria-hidden />
          </Button>
        </header>
        <main id="main" className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-8">
            {children ?? <Outlet />}
          </div>
        </main>
      </div>

      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent
          title="pamA"
          closeLabel={t.common.close}
          className="inset-x-auto inset-y-0 left-0 top-0 m-0 h-full max-h-none w-72 max-w-[85vw] rounded-none rounded-r-card"
        >
          <div className="flex h-[calc(100%-3rem)] flex-col gap-4">
            <nav aria-label={t.nav.main} className="flex-1 overflow-y-auto">
              <NavList collapsed={false} onNavigate={() => setMobileOpen(false)} />
            </nav>
            <FooterControls collapsed={false} />
          </div>
        </DialogContent>
      </Dialog>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        items={commands}
        title={t.nav.commandPalette}
        placeholder={t.nav.commandPlaceholder}
        empty={t.nav.commandEmpty}
      />
    </div>
  );
}

/** Tabs that are links, for sections with sub-pages (Library, Activity). */
export function SubNav({ items }: { items: { to: string; label: string; exact?: boolean }[] }) {
  return (
    <nav className="-mt-2 mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {items.map((i) => (
        <Link
          key={i.to}
          to={i.to}
          activeOptions={{ exact: i.exact ?? false }}
          className="-mb-px inline-flex h-9 items-center whitespace-nowrap border-b-2 border-transparent px-3 text-ui font-medium text-muted transition-colors hover:text-fg data-[status=active]:border-accent data-[status=active]:text-fg"
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
