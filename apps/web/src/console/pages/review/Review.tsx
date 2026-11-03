// Review queue (US1, spec 008a): read each draft digest, then approve, edit (structured editor)
// or discard it. Keyboard: j/k move between drafts, a approve, e edit, d discard.
import { useI18n } from "@pama/i18n";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  cn,
  ErrorBanner,
  PageHeader,
  SkeletonList,
  StatusPill,
  Switch,
  type Tone,
  useConfirm,
  useToast,
} from "@pama/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FilePen, Keyboard, Pencil, X } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { api, errorMessage } from "../../../lib/api.ts";
import { queries } from "../../../lib/query.ts";
import { ReviewPipelineState } from "../activity/ReviewPipelineState.tsx";
import { AgentBadge, BranchChips } from "../library/parts.tsx";
import { DigestEditor } from "./DigestEditor.tsx";
import type { DigestContent, Draft, Project } from "./types.ts";

const LABEL_TONE: Record<string, Tone> = {
  infra: "accent",
  business_sensitive: "warning",
  customer: "danger",
};

function Labels({ labels }: { labels?: string[] | undefined }) {
  const { t } = useI18n();
  if (!labels?.length) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
      {labels.map((l) => (
        <Badge key={l} tone={LABEL_TONE[l] ?? "neutral"}>
          {t.lib.editor.labelNames[l] ?? l}
        </Badge>
      ))}
    </span>
  );
}

export function DigestView({ c }: { c: DigestContent }) {
  const { t } = useI18n();
  const r = t.lib.review;
  const ed = t.lib.editor;
  return (
    <div className="space-y-3 text-sm leading-6">
      <p>
        <span className="font-medium">{ed.goal}.</span> {c.goal}
      </p>
      {c.decisions.length > 0 && (
        <ol className="list-decimal space-y-2 pl-5 marker:text-faint">
          {c.decisions.map((d) => (
            <li key={d.id}>
              <span className="font-medium">{d.what}</span>
              <Labels labels={d.labels} />
              {d.why && (
                <div className="text-muted">
                  {r.why}: {d.why}
                </div>
              )}
              {!!d.alternatives?.length && (
                <div className="text-faint">
                  {r.rejected}: {d.alternatives.join("; ")}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {c.outcome && (
        <p>
          <span className="font-medium">{r.outcome}.</span> {c.outcome}
        </p>
      )}
      {c.open_items.length > 0 && (
        <p>
          <span className="font-medium">{r.open}.</span> {c.open_items.join(" · ")}
        </p>
      )}
      <p className="text-xs text-muted">
        {c.modules.length > 0 && (
          <>
            {r.modules}: {c.modules.join(", ")} ·{" "}
          </>
        )}
        {ed.redactions(c.redactions.secret, c.redactions.pii)}
      </p>
    </div>
  );
}

export interface DraftHandle {
  approve: () => void;
  edit: () => void;
  discard: () => void;
  focus: () => void;
}

const DraftCard = forwardRef<
  DraftHandle,
  { d: Draft; active: boolean; label: string; onDone: () => void; onSelect: () => void }
>(function DraftCard({ d, active, label, onDone, onSelect }, ref) {
  const { t } = useI18n();
  const r = t.lib.review;
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const el = useRef<HTMLElement>(null);
  const act = useMutation({
    mutationFn: ({ path, json }: { path: string; json?: unknown; done: string }) =>
      api(path, { json: json ?? {} }),
    onSuccess: (_r, v) => {
      toast.success(v.done);
      setEditing(false);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const approve = (content?: DigestContent) => {
    setError(null);
    act.mutate({
      path: `/v1/digests/${d.id}/approve`,
      json: content ? { content } : {},
      done: r.approved,
    });
  };
  const discard = async () => {
    const ok = await confirm({
      title: r.discardTitle,
      description: r.discardBody,
      confirmLabel: r.discard,
      cancelLabel: t.common.cancel,
      danger: true,
    });
    if (ok) act.mutate({ path: `/v1/digests/${d.id}/discard`, done: r.discarded });
  };
  useImperativeHandle(ref, () => ({
    approve: () => {
      if (!editing && !act.isPending) approve();
    },
    edit: () => setEditing(true),
    discard: () => {
      if (!editing && !act.isPending) void discard();
    },
    focus: () => {
      el.current?.focus();
      el.current?.scrollIntoView?.({ block: "nearest" });
    },
  }));

  return (
    <article
      ref={el}
      tabIndex={-1}
      aria-label={label}
      aria-current={active ? "true" : undefined}
      onFocus={onSelect}
      className="rounded-card outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/40"
    >
      <Card className={cn("transition-colors", active && "border-accent ring-1 ring-accent/40")}>
        <CardHeader
          title={
            <>
              {d.project} <span className="font-normal text-muted">/ {d.bundle}</span>
            </>
          }
          description={
            <span className="flex flex-wrap items-center gap-2">
              <AgentBadge agent={d.content.source.agent} />
              {d.device && <span>{r.from(d.device)}</span>}
              <span>{new Date(d.created_at).toLocaleString()}</span>
              {!!d.branches?.length && <BranchChips branches={d.branches} max={3} />}
            </span>
          }
          actions={
            <StatusPill tone="warning" icon={FilePen}>
              {t.lib.status.draft}
            </StatusPill>
          }
        />
        {error && <ErrorBanner className="mb-3" title={r.saveFailed} message={error} />}
        {editing ? (
          <DigestEditor
            content={d.content}
            saving={act.isPending}
            onSave={(c) => approve(c)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <DigestView c={d.content} />
            <footer className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button
                variant="primary"
                loading={act.isPending}
                onClick={() => approve()}
                aria-keyshortcuts="a"
              >
                <Check aria-hidden />
                {r.approve}
              </Button>
              <Button onClick={() => setEditing(true)} aria-keyshortcuts="e">
                <Pencil aria-hidden />
                {r.edit}
              </Button>
              <Button
                variant="danger"
                disabled={act.isPending}
                onClick={() => void discard()}
                aria-keyshortcuts="d"
              >
                <X aria-hidden />
                {r.discard}
              </Button>
            </footer>
          </>
        )}
      </Card>
    </article>
  );
});

function AutoApprove({ projects, reload }: { projects: Project[]; reload: () => void }) {
  const { t } = useI18n();
  const r = t.lib.review;
  const toast = useToast();
  if (!projects.length) return null;
  return (
    <Card className="h-fit">
      <CardHeader title={r.autoApprove} description={r.autoApproveHint} />
      <ul className="space-y-3">
        {projects.map((p) => (
          <li key={p.id} className="flex items-center gap-3">
            <Switch
              id={`auto-${p.id}`}
              checked={p.auto_approve === true}
              onCheckedChange={async (checked) => {
                try {
                  await api(`/v1/projects/${p.id}`, {
                    method: "PATCH",
                    json: { auto_approve: checked },
                  });
                } catch (e) {
                  toast.error(r.autoApproveFailed, errorMessage(e));
                }
                reload();
              }}
            />
            <label htmlFor={`auto-${p.id}`} className="min-w-0 text-ui">
              <span className="block font-medium">{p.name}</span>
              <span className="block truncate font-mono text-xs text-faint">{p.repo_key}</span>
            </label>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-subtle px-1 font-mono text-xs text-fg">
      {children}
    </kbd>
  );
}

function ShortcutHint() {
  const { t } = useI18n();
  const k = t.lib.review.keys;
  return (
    <div
      role="note"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"
      aria-label={t.lib.review.shortcuts}
    >
      <Keyboard aria-hidden className="size-4 text-faint" />
      <span>
        <Kbd>a</Kbd> {k.a}
      </span>
      <span>
        <Kbd>e</Kbd> {k.e}
      </span>
      <span>
        <Kbd>d</Kbd> {k.d}
      </span>
      <span>
        <Kbd>j</Kbd>/<Kbd>k</Kbd> {k.jk}
      </span>
    </div>
  );
}

/** True when a key press belongs to something else: a field, a dialog or a modifier chord. */
function ignoreKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return true;
  const el = e.target as HTMLElement | null;
  if (el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']"))
    return true;
  if (el?.closest?.("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']"))
    return true;
  return Boolean(document.querySelector("[role='dialog'], [role='alertdialog']"));
}

export function Review() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const drafts = useQuery({
    ...queries.review,
    queryFn: () => api<{ items: Draft[] }>("/v1/review"),
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ items: Project[] }>("/v1/projects"),
  });
  const reload = useCallback(() => {
    void qc.invalidateQueries({ queryKey: queries.review.queryKey });
    void qc.invalidateQueries({ queryKey: ["projects"] });
    void qc.invalidateQueries({ queryKey: ["library"] });
  }, [qc]);

  const items = drafts.data?.items ?? [];
  const [active, setActive] = useState(0);
  const handles = useRef(new Map<string, DraftHandle>());
  const current = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!items.length || ignoreKey(e)) return;
      const key = e.key.toLowerCase();
      const go = (i: number) => {
        e.preventDefault();
        const next = Math.max(0, Math.min(items.length - 1, i));
        setActive(next);
        const id = items[next]?.id;
        if (id) handles.current.get(id)?.focus();
      };
      const h = items[current] ? handles.current.get(items[current].id) : undefined;
      if (key === "j") go(current + 1);
      else if (key === "k") go(current - 1);
      else if (key === "a" && h) {
        e.preventDefault();
        h.approve();
      } else if (key === "e" && h) {
        e.preventDefault();
        h.edit();
      } else if (key === "d" && h) {
        e.preventDefault();
        h.discard();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [items, current]);

  return (
    <>
      <PageHeader
        title={t.pages.review.title}
        description={t.pages.review.description}
        actions={items.length > 0 ? <ShortcutHint /> : undefined}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <section className="min-w-0 space-y-4" aria-label={t.pages.review.title}>
          {drafts.isPending && <SkeletonList label={t.common.loading} />}
          {drafts.isError && (
            <ErrorBanner
              title={t.common.loadFailed}
              message={errorMessage(drafts.error)}
              onRetry={() => void drafts.refetch()}
              retryLabel={t.common.retry}
            />
          )}
          {drafts.data?.items.length === 0 && <ReviewPipelineState />}
          {items.map((d, i) => (
            <DraftCard
              key={d.id}
              ref={(h) => {
                if (h) handles.current.set(d.id, h);
                else handles.current.delete(d.id);
              }}
              d={d}
              active={i === current}
              label={t.lib.review.draftOf(i + 1, items.length)}
              onDone={reload}
              onSelect={() => setActive(i)}
            />
          ))}
        </section>
        <AutoApprove projects={projects.data?.items ?? []} reload={reload} />
      </div>
    </>
  );
}
