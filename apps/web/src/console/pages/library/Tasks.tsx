// Tasks tab (API name "bundles"): the agent sessions of one piece of work, per project. Rename in
// place, merge several, open a task to split it.
import { useI18n } from "@pama/i18n";
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Notice,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from "@pama/ui";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, CloudUpload, HardDrive, Info, Layers, Merge, Pencil, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { errorMessage } from "../../../lib/api.ts";
import { type Bundle, taskApi, useBundles, useLibraryRefresh, usePublishState } from "./data.ts";
import { BranchChips, QueryView, useFormatDate } from "./parts.tsx";

export function PublishPill({ published }: { published: boolean | undefined }) {
  const { t } = useI18n();
  const l = t.lib.library;
  if (published === undefined) return null;
  return published ? (
    <StatusPill tone="accent" icon={CloudUpload} title={l.publishedHint}>
      {l.published}
    </StatusPill>
  ) : (
    <StatusPill tone="neutral" icon={HardDrive} title={l.privateHint}>
      {l.private}
    </StatusPill>
  );
}

/** A task name that turns into a text field; Enter saves, Escape cancels. */
export function InlineRename({ task, linkTo }: { task: Bundle; linkTo?: string }) {
  const { t } = useI18n();
  const l = t.lib.library;
  const toast = useToast();
  const refresh = useLibraryRefresh();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(task.name);
  const rename = useMutation({
    mutationFn: (n: string) => taskApi.rename(task.id, n),
    onSuccess: async () => {
      toast.success(l.renamed);
      setEditing(false);
      await refresh();
    },
    onError: (e) => toast.error(t.common.error, errorMessage(e)),
  });
  const save = (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n || n === task.name) return setEditing(false);
    rename.mutate(n);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setName(task.name);
      setEditing(false);
    }
  };
  if (editing)
    return (
      <form onSubmit={save} className="flex min-w-0 items-center gap-1">
        <Input
          autoFocus
          aria-label={l.renameLabel(task.name)}
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKey}
          className="min-w-40"
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          loading={rename.isPending}
          aria-label={t.common.save}
        >
          <Check aria-hidden />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t.common.cancel}
          onClick={() => {
            setName(task.name);
            setEditing(false);
          }}
        >
          <X aria-hidden />
        </Button>
      </form>
    );
  return (
    <span className="flex min-w-0 items-center gap-1">
      {linkTo ? (
        <Link to={linkTo} className="truncate font-medium text-fg hover:underline">
          {task.name}
        </Link>
      ) : (
        <span className="truncate font-medium text-fg">{task.name}</span>
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-label={`${l.rename}: ${task.name}`}
        title={l.rename}
        onClick={() => {
          setName(task.name);
          setEditing(true);
        }}
      >
        <Pencil aria-hidden />
      </Button>
    </span>
  );
}

function MergeDialog({
  tasks,
  open,
  onOpenChange,
  onMerged,
}: {
  tasks: Bundle[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onMerged: () => void;
}) {
  const { t } = useI18n();
  const l = t.lib.library;
  const toast = useToast();
  const refresh = useLibraryRefresh();
  const [name, setName] = useState("");
  const [shownFor, setShownFor] = useState<boolean>(false);
  if (open !== shownFor) {
    setShownFor(open);
    if (open) setName(tasks[0]?.name ?? "");
  }
  const merge = useMutation({
    mutationFn: () =>
      taskApi.merge(
        tasks.map((x) => x.id),
        name.trim(),
      ),
    onSuccess: async () => {
      toast.success(l.merged);
      onOpenChange(false);
      onMerged();
      await refresh();
    },
    onError: (e) => toast.error(t.common.error, errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={l.mergeTitle(tasks.length)}
        description={l.mergeBody}
        closeLabel={t.common.close}
        role="alertdialog"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) merge.mutate();
          }}
        >
          <ul className="mb-3 list-disc space-y-0.5 pl-5 text-ui text-muted">
            {tasks.map((x) => (
              <li key={x.id}>{x.name}</li>
            ))}
          </ul>
          <Field label={l.mergeName}>
            <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{t.common.cancel}</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!name.trim()}
              loading={merge.isPending}
            >
              <Merge aria-hidden />
              {l.mergeConfirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function byProject(items: Bundle[]) {
  const out = new Map<string, { project: string; tasks: Bundle[] }>();
  for (const b of items) {
    const g = out.get(b.project_id) ?? { project: b.project, tasks: [] };
    g.tasks.push(b);
    out.set(b.project_id, g);
  }
  return [...out.entries()].sort(([, a], [, b]) => a.project.localeCompare(b.project));
}

export function Tasks() {
  const { t } = useI18n();
  const l = t.lib.library;
  const fmt = useFormatDate();
  const bundles = useBundles();
  const published = usePublishState();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);

  const all = bundles.data?.items ?? [];
  const chosen = all.filter((b) => picked.has(b.id));
  const sameProject = new Set(chosen.map((b) => b.project_id)).size <= 1;
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <section className="space-y-4" aria-label={l.tabs.tasks}>
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto flex max-w-prose items-start gap-2 text-ui text-muted">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-ink" />
          {l.tasksExplain}
        </p>
        <Button disabled={chosen.length < 2 || !sameProject} onClick={() => setMerging(true)}>
          <Merge aria-hidden />
          {l.merge(chosen.length)}
        </Button>
      </div>
      {!sameProject && <Notice tone="warning">{l.mergeSameProject}</Notice>}
      <QueryView
        query={bundles}
        isEmpty={(d) => d.items.length === 0}
        empty={{ icon: Layers, title: t.pages.tasks.empty, description: t.pages.tasks.emptyHint }}
      >
        {(d) =>
          byProject(d.items).map(([projectId, g]) => (
            <Card key={projectId} className="p-0 sm:p-0">
              <CardHeader className="mb-0 px-4 pt-4 pb-3 sm:px-5" title={g.project} />
              <Table label={g.project} wrapperClassName="rounded-none border-x-0 border-b-0">
                <THead>
                  <tr>
                    <TH className="w-8">
                      <span className="sr-only">{l.selectColumn}</span>
                    </TH>
                    <TH>{l.task}</TH>
                    <TH>{l.branches}</TH>
                    <TH>{t.lib.library.tabs.sessions}</TH>
                    {published && <TH>{l.published}</TH>}
                    <TH>{l.lastActivity}</TH>
                  </tr>
                </THead>
                <TBody>
                  {g.tasks.map((b) => (
                    <TR key={b.id}>
                      <TD>
                        <Checkbox
                          aria-label={l.select(b.name)}
                          checked={picked.has(b.id)}
                          onCheckedChange={() => toggle(b.id)}
                        />
                      </TD>
                      <TD className="min-w-56 max-w-md">
                        <InlineRename task={b} linkTo={`/library/tasks/${b.id}`} />
                      </TD>
                      <TD className="min-w-40">
                        <BranchChips branches={b.branches} max={3} />
                      </TD>
                      <TD className="whitespace-nowrap tabular-nums text-muted">
                        {l.sessions(b.session_count)}
                      </TD>
                      {published && (
                        <TD>
                          <PublishPill published={published.get(b.id) ?? false} />
                        </TD>
                      )}
                      <TD className="whitespace-nowrap text-muted">{fmt(b.last_activity)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          ))
        }
      </QueryView>
      <MergeDialog
        tasks={chosen}
        open={merging}
        onOpenChange={setMerging}
        onMerged={() => setPicked(new Set())}
      />
    </section>
  );
}
