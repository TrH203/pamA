// Conversations (spec 008, US3): every Ask Link conversation with filters by status (the old
// Inbox is "Needs reply"), link, source and date, plus JSON/CSV export. A row opens the thread.
import { useI18n } from "@pama/i18n";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  SkeletonList,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from "@pama/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Archive, BadgeCheck, Download, MessagesSquare, X } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../../../lib/api.ts";
import {
  type ConversationSummary,
  conversationApi,
  convKeys,
  download,
  exportConversations,
  type Filters,
  type Origin,
  type StatusFilter,
} from "./api.ts";

const STATUSES: (StatusFilter | "all")[] = ["all", "needs_reply", "open", "archived"];
const ORIGINS: Origin[] = ["link", "owner_chat", "hotkey"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The router search params of /conversations, validated. */
export function conversationSearch(s: Record<string, unknown>): Filters {
  const out: Filters = {};
  if (s.status === "open" || s.status === "archived" || s.status === "needs_reply")
    out.status = s.status;
  if (typeof s.link === "string" && s.link) out.link = s.link;
  if (s.origin === "link" || s.origin === "owner_chat" || s.origin === "hotkey")
    out.origin = s.origin;
  if (typeof s.from === "string" && DATE.test(s.from)) out.from = s.from;
  if (typeof s.to === "string" && DATE.test(s.to)) out.to = s.to;
  return out;
}

/** The server's `to` is exclusive; the date field means "up to and including that day". */
function serverFilters(f: Filters): Filters {
  if (!f.to) return f;
  const d = new Date(`${f.to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return { ...f, to: d.toISOString().slice(0, 10) };
}

const when = (d: string) => new Date(d).toLocaleString();

function Row({ c }: { c: ConversationSummary }) {
  const { t } = useI18n();
  const s = t.convo.list;
  return (
    <TR>
      <TD className="min-w-56">
        <Link
          to="/conversations/$id"
          params={{ id: c.id }}
          className="font-medium text-fg hover:text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {c.title || s.untitled}
        </Link>
        <p className="mt-0.5 text-xs text-muted">
          {c.origin === "link" ? (c.link_title ?? c.link_slug ?? s.link) : t.convo.origin[c.origin]}
        </p>
      </TD>
      <TD className="whitespace-nowrap">
        {c.asker_email ? (
          <Badge tone="success">
            <BadgeCheck aria-hidden />
            {c.asker_email}
          </Badge>
        ) : (
          <span className="text-muted">{c.origin === "link" ? s.anonymous : "—"}</span>
        )}
      </TD>
      <TD className="whitespace-nowrap">
        <span className="flex flex-wrap gap-1">
          {c.needs_reply > 0 && <StatusPill tone="accent">{s.waiting(c.needs_reply)}</StatusPill>}
          {c.status === "archived" && (
            <StatusPill tone="neutral" icon={Archive}>
              {s.archived}
            </StatusPill>
          )}
        </span>
      </TD>
      <TD className="whitespace-nowrap text-muted">{s.turns(c.turns)}</TD>
      <TD className="whitespace-nowrap text-muted">
        <time dateTime={c.last_at}>{when(c.last_at)}</time>
      </TD>
    </TR>
  );
}

function ExportButtons({ filters }: { filters: Filters }) {
  const { t } = useI18n();
  const s = t.convo.list;
  const toast = useToast();
  const [busy, setBusy] = useState<"json" | "csv" | null>(null);
  const run = async (format: "json" | "csv") => {
    setBusy(format);
    try {
      const blob = await exportConversations(filters, format);
      download(blob, `pama-conversations.${format}`);
      toast.success(s.exported);
    } catch (e) {
      toast.error(s.exportFailed, errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button size="sm" loading={busy === "json"} disabled={!!busy} onClick={() => run("json")}>
        {busy !== "json" && <Download aria-hidden />}
        {s.exportJson}
      </Button>
      <Button size="sm" loading={busy === "csv"} disabled={!!busy} onClick={() => run("csv")}>
        {busy !== "csv" && <Download aria-hidden />}
        {s.exportCsv}
      </Button>
    </>
  );
}

export function ConversationsPage() {
  const { t } = useI18n();
  const s = t.convo.list;
  const navigate = useNavigate();
  const filters = conversationSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const set = (patch: Partial<Filters>) =>
    void navigate({
      to: "/conversations",
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...conversationSearch(prev), ...patch };
        for (const k of Object.keys(next))
          if (next[k] === undefined || next[k] === "") delete next[k];
        return next;
      },
      replace: true,
    });
  const query = serverFilters(filters);
  const list = useInfiniteQuery({
    queryKey: convKeys.list(query),
    queryFn: ({ pageParam }) => conversationApi.list(query, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_offset ?? undefined,
  });
  const links = useQuery({
    queryKey: ["links"],
    queryFn: conversationApi.links,
    staleTime: 60_000,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(filters.link || filters.origin || filters.from || filters.to);
  const statusLabel = (v: StatusFilter | "all") =>
    v === "all" ? s.all : v === "needs_reply" ? s.needsReply : v === "open" ? s.open : s.archived;

  return (
    <>
      <PageHeader
        title={s.title}
        description={s.description}
        actions={<ExportButtons filters={query} />}
      />
      <section aria-label={s.filters} className="mb-4 space-y-3">
        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">{s.state}</legend>
          {STATUSES.map((v) => {
            const active = (filters.status ?? "all") === v;
            return (
              <Button
                key={v}
                size="sm"
                variant={active ? "primary" : "secondary"}
                aria-pressed={active}
                onClick={() => set({ status: v === "all" ? undefined : v })}
              >
                {statusLabel(v)}
              </Button>
            );
          })}
        </fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto_auto] lg:items-end">
          <Field label={s.link}>
            <Select value={filters.link ?? ""} onChange={(e) => set({ link: e.target.value })}>
              <option value="">{s.anyLink}</option>
              {links.data?.items.map((l) => (
                <option key={l.slug} value={l.slug}>
                  {l.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={s.origin}>
            <Select
              value={filters.origin ?? ""}
              onChange={(e) => set({ origin: (e.target.value || undefined) as Origin | undefined })}
            >
              <option value="">{s.all}</option>
              {ORIGINS.map((o) => (
                <option key={o} value={o}>
                  {t.convo.origin[o]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={s.from}>
            <Input
              type="date"
              value={filters.from ?? ""}
              onChange={(e) => set({ from: e.target.value })}
            />
          </Field>
          <Field label={s.to}>
            <Input
              type="date"
              value={filters.to ?? ""}
              onChange={(e) => set({ to: e.target.value })}
            />
          </Field>
          {filtered && (
            <Button
              variant="ghost"
              onClick={() =>
                set({ link: undefined, origin: undefined, from: undefined, to: undefined })
              }
            >
              <X aria-hidden />
              {s.clear}
            </Button>
          )}
        </div>
      </section>

      {list.isPending && <SkeletonList label={t.common.loading} />}
      {list.isError && (
        <ErrorBanner
          title={t.common.loadFailed}
          message={errorMessage(list.error)}
          onRetry={() => void list.refetch()}
          retryLabel={t.common.retry}
        />
      )}
      {list.isSuccess && items.length === 0 && (
        <EmptyState
          icon={MessagesSquare}
          title={
            filtered
              ? s.emptyFiltered
              : filters.status === "needs_reply"
                ? s.emptyNeedsReply
                : s.empty
          }
          description={
            filtered
              ? s.emptyFilteredHint
              : filters.status === "needs_reply"
                ? s.emptyNeedsReplyHint
                : s.emptyHint
          }
        />
      )}
      {items.length > 0 && (
        <div className="space-y-3">
          <Table label={s.title}>
            <THead>
              <tr>
                <TH>{s.title}</TH>
                <TH>{s.asker}</TH>
                <TH>{s.state}</TH>
                <TH>{s.questions}</TH>
                <TH>{s.lastActivity}</TH>
              </tr>
            </THead>
            <TBody>
              {items.map((c) => (
                <Row key={c.id} c={c} />
              ))}
            </TBody>
          </Table>
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {s.more}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
