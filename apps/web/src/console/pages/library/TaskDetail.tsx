// One task: its branches, sessions and publish state; rename it or split sessions out.
import { useI18n } from "@pama/i18n";
import {
  Button,
  buttonClass,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  useToast,
} from "@pama/ui";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Layers, Split } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../../../lib/api.ts";
import { type Bundle, taskApi, useBundles, useLibraryRefresh, usePublishState } from "./data.ts";
import { AgentBadge, BranchChips, QueryView, useFormatDate } from "./parts.tsx";
import { InlineRename, PublishPill } from "./Tasks.tsx";

function SplitDialog({
  task,
  picked,
  open,
  onOpenChange,
}: {
  task: Bundle;
  picked: string[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useI18n();
  const l = t.lib.library;
  const toast = useToast();
  const refresh = useLibraryRefresh();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const split = useMutation({
    mutationFn: () => taskApi.split(task.id, picked, name.trim()),
    onSuccess: async (r) => {
      toast.success(l.splitDone);
      onOpenChange(false);
      setName("");
      await refresh();
      void navigate({ to: `/library/tasks/${r.id}` });
    },
    onError: (e) => toast.error(t.common.error, errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={l.splitTitle}
        description={l.splitBody(picked.length)}
        closeLabel={t.common.close}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) split.mutate();
          }}
        >
          <Field label={l.splitName}>
            <Input
              autoFocus
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{t.common.cancel}</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!name.trim()}
              loading={split.isPending}
            >
              <Split aria-hidden />
              {l.splitConfirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TaskView({ task }: { task: Bundle }) {
  const { t } = useI18n();
  const l = t.lib.library;
  const fmt = useFormatDate();
  const published = usePublishState();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [splitting, setSplitting] = useState(false);
  const canSplit = picked.size > 0 && picked.size < task.sessions.length;
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={<InlineRename task={task} />}
          description={task.project}
          actions={published && <PublishPill published={published.get(task.id) ?? false} />}
        />
        <dl className="grid gap-x-6 gap-y-3 text-ui sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">{l.branches}</dt>
          <dd>
            <BranchChips branches={task.branches} max={12} />
          </dd>
          <dt className="text-muted">{l.tabs.sessions}</dt>
          <dd className="tabular-nums">{l.sessions(task.session_count)}</dd>
          <dt className="text-muted">{l.lastActivity}</dt>
          <dd>{fmt(task.last_activity)}</dd>
        </dl>
      </Card>
      <Card>
        <CardHeader
          title={l.tabs.sessions}
          description={task.sessions.length > 1 ? l.splitPick : undefined}
          actions={
            task.sessions.length > 1 && (
              <Button disabled={!canSplit} onClick={() => setSplitting(true)}>
                <Split aria-hidden />
                {l.split}
              </Button>
            )
          }
        />
        <ul className="divide-y divide-line border-t border-line">
          {task.sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
              {task.sessions.length > 1 && (
                <Checkbox
                  aria-label={l.select(s.agent_session_id.slice(0, 8))}
                  checked={picked.has(s.id)}
                  onCheckedChange={() => toggle(s.id)}
                />
              )}
              <AgentBadge agent={s.agent} />
              <Link
                to={`/library/sessions/${s.id}`}
                className="font-mono text-xs text-fg hover:underline"
              >
                {s.agent_session_id.slice(0, 12)}
              </Link>
              <BranchChips branches={s.branches} max={3} />
              <span className="ml-auto text-xs text-muted">{fmt(s.ended_at)}</span>
            </li>
          ))}
        </ul>
      </Card>
      <SplitDialog
        task={task}
        picked={[...picked]}
        open={splitting}
        onOpenChange={(o) => {
          setSplitting(o);
          if (!o) setPicked(new Set());
        }}
      />
    </div>
  );
}

export function TaskDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const l = t.lib.library;
  const bundles = useBundles();
  return (
    <section className="space-y-4" aria-label={l.task}>
      <Link to="/library/tasks" className={buttonClass("ghost", "sm")}>
        <ArrowLeft aria-hidden />
        {l.backToTasks}
      </Link>
      <QueryView query={bundles} empty={{ icon: Layers, title: l.taskNotFound }}>
        {(d) => {
          const task = d.items.find((b) => b.id === id);
          return task ? (
            <TaskView key={task.id} task={task} />
          ) : (
            <EmptyState icon={Layers} title={l.taskNotFound} description={l.taskNotFoundHint} />
          );
        }}
      </QueryView>
    </section>
  );
}

/** Route component for /library/tasks/$id. */
export function TaskDetailRoute() {
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  return <TaskDetail id={id} />;
}
