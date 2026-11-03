// One agent session: agent, times, branches, digest versions (with a comparison between two of
// them) and the owner's actions: withdraw, delete, move to another task, and the Ask Links that
// use it.
import { useI18n } from "@pama/i18n";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  CardHeader,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  Notice,
  Select,
  SkeletonList,
  useConfirm,
  useToast,
} from "@pama/ui";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRightLeft,
  Info,
  Link2,
  Minus,
  Plus,
  Terminal,
  Trash2,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { api, errorMessage, isApiError } from "../../../lib/api.ts";
import {
  type SessionDetail as Detail,
  taskApi,
  useBundles,
  useDigest,
  useLibraryRefresh,
  useSession,
} from "./data.ts";
import { diffDigests, hasChanges } from "./diff.ts";
import { AgentBadge, DigestStatusPill, QueryView, useFormatDate } from "./parts.tsx";

function Compare({ versions }: { versions: Detail["digests"] }) {
  const { t } = useI18n();
  const l = t.lib.library;
  const e = t.lib.editor;
  const [newer, setNewer] = useState(versions[0]?.id ?? "");
  const [older, setOlder] = useState(versions[1]?.id ?? "");
  const a = useDigest(older);
  const b = useDigest(newer);
  const titles: Record<string, string> = {
    goal: e.goal,
    decisions: e.decisions,
    outcome: e.outcome,
    open_items: e.openItems,
    modules: e.modules,
  };
  const label = (id: string) => {
    const v = versions.find((x) => x.id === id);
    return v ? `${l.version(v.version)} · ${t.lib.status[v.status] ?? v.status}` : "";
  };
  const sections = a.data && b.data ? diffDigests(a.data.content, b.data.content) : null;
  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap gap-3">
        <Field label={l.compare} className="min-w-40 flex-1 sm:max-w-56">
          <Select value={newer} onChange={(ev) => setNewer(ev.target.value)}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {label(v.id)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={l.compareWith} className="min-w-40 flex-1 sm:max-w-56">
          <Select value={older} onChange={(ev) => setOlder(ev.target.value)}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {label(v.id)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="text-xs text-muted">{l.compareHint}</p>
      {(a.isPending || b.isPending) && <SkeletonList rows={1} label={t.common.loading} />}
      {(a.isError || b.isError) && (
        <Notice tone="warning">{errorMessage(a.error ?? b.error)}</Notice>
      )}
      {sections && !hasChanges(sections) && <p className="text-ui text-muted">{l.noChanges}</p>}
      {sections && hasChanges(sections) && (
        <div className="space-y-3">
          {sections.map((s) => (
            <div key={s.key}>
              <h4 className="mb-1 text-xs font-medium text-muted">{titles[s.key]}</h4>
              <ul className="space-y-1 font-mono text-xs">
                {s.lines.map((line) => (
                  <li
                    key={`${line.mark}:${line.text}`}
                    className={cn(
                      "flex gap-2 rounded-control px-2 py-1",
                      line.mark === "added" && "bg-success-soft text-success-ink",
                      line.mark === "removed" && "bg-danger-soft text-danger-ink line-through",
                      line.mark === "same" && "text-muted",
                    )}
                  >
                    {line.mark === "added" && (
                      <Plus aria-hidden className="mt-0.5 size-3 shrink-0" />
                    )}
                    {line.mark === "removed" && (
                      <Minus aria-hidden className="mt-0.5 size-3 shrink-0" />
                    )}
                    {line.mark === "same" && <span aria-hidden className="w-3 shrink-0" />}
                    <span className="sr-only">
                      {line.mark === "added"
                        ? l.added
                        : line.mark === "removed"
                          ? l.removed
                          : l.unchanged}
                      :
                    </span>
                    <span className="min-w-0 break-words">{line.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MoveDialog({
  session,
  open,
  onOpenChange,
}: {
  session: Detail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useI18n();
  const l = t.lib.library;
  const toast = useToast();
  const refresh = useLibraryRefresh();
  const bundles = useBundles();
  const options = (bundles.data?.items ?? []).filter(
    (b) => b.project_id === session.project_id && b.id !== session.bundle_id,
  );
  const [target, setTarget] = useState("");
  const chosen = options.find((b) => b.id === target) ?? options[0];
  const move = useMutation({
    mutationFn: () => {
      if (!chosen) throw new Error(l.moveNone);
      return taskApi.moveSession(session, chosen);
    },
    onSuccess: async () => {
      toast.success(l.moved);
      onOpenChange(false);
      await refresh();
    },
    onError: (e) => toast.error(t.common.error, errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={l.moveTitle} description={session.bundle} closeLabel={t.common.close}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            move.mutate();
          }}
        >
          {bundles.isPending ? (
            <SkeletonList rows={1} label={t.common.loading} />
          ) : options.length === 0 ? (
            <Notice>{l.moveNone}</Notice>
          ) : (
            <Field label={l.moveLabel}>
              <Select value={chosen?.id ?? ""} onChange={(e) => setTarget(e.target.value)}>
                {options.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{t.common.cancel}</Button>
            <Button type="submit" variant="primary" disabled={!chosen} loading={move.isPending}>
              {l.moveConfirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SessionView({ s }: { s: Detail }) {
  const { t } = useI18n();
  const l = t.lib.library;
  const fmt = useFormatDate();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const refresh = useLibraryRefresh();
  const [moving, setMoving] = useState(false);
  const approved = s.digests.find((d) => d.status === "approved");

  const withdraw = useMutation({
    mutationFn: (id: string) => api(`/v1/digests/${encodeURIComponent(id)}/withdraw`, { json: {} }),
    onSuccess: async () => {
      toast.success(l.withdrawn);
      await refresh();
    },
    onError: (e) => toast.error(t.common.error, errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: () =>
      api<{ deleted: string; links: unknown[] }>(`/v1/sessions/${encodeURIComponent(s.id)}`, {
        method: "DELETE",
      }),
    onSuccess: async (r) => {
      const lost = Array.isArray(r.links) ? r.links.length : 0;
      toast.success(l.deleted, lost ? l.deletedLinks(lost) : undefined);
      await refresh();
      void navigate({ to: "/library/sessions" });
    },
    onError: (e) => toast.error(t.common.error, errorMessage(e)),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader
            title={s.digests[0]?.goal ?? l.noGoal}
            description={
              <>
                <Link to={`/library/tasks/${s.bundle_id}`} className="hover:underline">
                  {s.bundle}
                </Link>{" "}
                · {s.project}
              </>
            }
            actions={<DigestStatusPill status={s.status} />}
          />
          <dl className="grid gap-x-6 gap-y-2 text-ui sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">{l.agent}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <AgentBadge agent={s.agent} />
              <code className="text-xs text-faint">{s.agent_session_id}</code>
            </dd>
            <dt className="text-muted">{l.started}</dt>
            <dd>{fmt(s.started_at)}</dd>
            <dt className="text-muted">{l.ended}</dt>
            <dd>{fmt(s.ended_at)}</dd>
            <dt className="text-muted">{l.capture}</dt>
            <dd className="text-muted">
              {s.capture ? (
                <code className="text-xs">{JSON.stringify(s.capture)}</code>
              ) : (
                l.captureLocal
              )}
            </dd>
          </dl>
        </Card>

        <Card>
          <CardHeader title={l.branches} />
          {s.branches.length === 0 ? (
            <p className="text-ui text-muted">{l.noBranch}</p>
          ) : (
            <ul className="divide-y divide-line">
              {s.branches.map((b) => (
                <li key={b.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <code className="text-ui text-fg">{b.name}</code>
                  <span className="text-xs text-muted">{l.events(b.event_count)}</span>
                  <span className="ml-auto text-xs text-faint">
                    {fmt(b.first_seen_at)} → {fmt(b.last_seen_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title={l.digestVersions} />
          {s.digests.length === 0 ? (
            <p className="text-ui text-muted">{l.noVersions}</p>
          ) : (
            <ol className="mb-4 divide-y divide-line">
              {s.digests.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <Badge>{l.version(d.version)}</Badge>
                  <DigestStatusPill status={d.status} />
                  <span className="min-w-0 flex-1 truncate text-ui">{d.goal}</span>
                  <span className="text-xs text-faint">
                    {fmt(d.created_at)}
                    {d.device ? ` · ${l.by(d.device)}` : ""}
                    {d.model ? ` · ${d.model}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {s.digests.length > 1 && <Compare versions={s.digests} />}
        </Card>
      </div>

      <aside className="space-y-4">
        <Card>
          <CardHeader title={l.actions} />
          <div className="flex flex-col gap-2">
            {approved && (
              <Button
                loading={withdraw.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: l.withdrawTitle,
                    description: l.withdrawBody,
                    confirmLabel: l.withdraw,
                    cancelLabel: t.common.cancel,
                  });
                  if (ok) withdraw.mutate(approved.id);
                }}
              >
                <Undo2 aria-hidden />
                {l.withdraw}
              </Button>
            )}
            <Button onClick={() => setMoving(true)}>
              <ArrowRightLeft aria-hidden />
              {l.move}
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: l.deleteTitle,
                  description: l.deleteBody,
                  confirmLabel: l.delete,
                  cancelLabel: t.common.cancel,
                  danger: true,
                });
                if (ok) del.mutate();
              }}
            >
              <Trash2 aria-hidden />
              {l.delete}
            </Button>
          </div>
        </Card>
        <Card>
          <CardHeader title={l.links} />
          {s.links.length === 0 ? (
            <p className="mb-3 text-ui text-muted">{l.linksEmpty}</p>
          ) : (
            <ul className="mb-3 space-y-2">
              {s.links.map((k) => (
                <li key={k.slug} className="text-ui">
                  <Link
                    to="/links"
                    search={{ q: k.slug }}
                    className="flex items-center gap-1.5 font-medium text-fg hover:underline"
                  >
                    <Link2 aria-hidden className="size-4 shrink-0 text-muted" />
                    <span className="truncate">{k.title}</span>
                  </Link>
                  <span className="text-xs text-faint">{l.expires(fmt(k.expires_at, false))}</span>
                </li>
              ))}
            </ul>
          )}
          <Link to="/links" search={{ new: true }} className={buttonClass("secondary", "sm")}>
            <Plus aria-hidden />
            {l.newLink}
          </Link>
        </Card>
      </aside>
      <MoveDialog session={s} open={moving} onOpenChange={setMoving} />
    </div>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const l = t.lib.library;
  const session = useSession(id);
  return (
    <section className="space-y-4" aria-label={l.session}>
      <Link to="/library/sessions" className={buttonClass("ghost", "sm")}>
        <ArrowLeft aria-hidden />
        {l.tabs.sessions}
      </Link>
      {session.isError && isApiError(session.error, 404) ? (
        <EmptyState icon={Terminal} title={l.sessionNotFound} />
      ) : (
        <QueryView query={session} empty={{ icon: Info, title: l.sessionNotFound }}>
          {(s) => <SessionView s={s} />}
        </QueryView>
      )}
    </section>
  );
}

/** Route component for /library/sessions/$id. */
export function SessionDetailRoute() {
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  return <SessionDetail key={id} id={id} />;
}
