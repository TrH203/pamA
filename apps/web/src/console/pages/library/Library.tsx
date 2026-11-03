// Library (spec 007, plan 6.3): Tasks, Sessions and Digests tabs under one header, with a search
// box over approved work. Each tab is its own URL so it deep-links.
import { useI18n } from "@pama/i18n";
import { Button, Input, PageHeader } from "@pama/ui";
import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { SubNav } from "../../Shell.tsx";

/** The search box: submits to /library/search?q=… (results grouped by task). */
export function LibrarySearchBox() {
  const { t } = useI18n();
  const l = t.lib.library;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { q?: string };
  const [q, setQ] = useState(search.q ?? "");
  useEffect(() => {
    if (search.q !== undefined) setQ(search.q);
  }, [search.q]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
    void navigate({ to: "/library/search", search: { q: text } });
  };
  return (
    <search className="w-full sm:w-96">
      <form onSubmit={submit} className="flex w-full gap-2">
        <label htmlFor="library-search" className="sr-only">
          {l.searchLabel}
        </label>
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint"
          />
          <Input
            id="library-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={l.searchPlaceholder}
            className="pl-8"
            maxLength={500}
          />
        </div>
        <Button type="submit" disabled={!q.trim()}>
          {l.searchSubmit}
        </Button>
      </form>
    </search>
  );
}

export function LibraryLayout() {
  const { t } = useI18n();
  const l = t.lib.library;
  return (
    <>
      <PageHeader
        title={t.pages.library.title}
        description={t.pages.library.description}
        actions={<LibrarySearchBox />}
      />
      <SubNav
        label={t.pages.library.title}
        items={[
          { to: "/library/tasks", label: l.tabs.tasks },
          { to: "/library/sessions", label: l.tabs.sessions },
          { to: "/library/digests", label: l.tabs.digests },
        ]}
      />
      <Outlet />
    </>
  );
}
