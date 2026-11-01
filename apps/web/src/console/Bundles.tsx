// Tasks (US1; API name "bundles"): agent sessions of one piece of work, grouped by branch by
// default. Rename, split and merge. The UI says "Task" (plan §2); the code keeps "bundle".
import { useI18n } from "@pama/i18n";
import {
  BundleSummary,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  SkeletonList,
  useToast,
} from "@pama/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Merge, Pencil, Split } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../lib/api.ts";
import type { Bundle } from "./types.ts";

interface Ask {
  title: string;
  label: string;
  initial?: string;
  submit: string;
  run: (name: string) => Promise<unknown>;
}

/** Asks for a name in a dialog (replaces window.prompt). */
function NameDialog({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [key, setKey] = useState<Ask | null>(null);
  if (ask !== key) {
    setKey(ask);
    setName(ask?.initial ?? "");
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ask || !name.trim()) return;
    // Failures are reported by the mutation's toast.
    ask.run(name.trim()).catch(() => undefined);
    onClose();
  };
  return (
    <Dialog open={ask !== null} onOpenChange={(o) => !o && onClose()}>
      {ask && (
        <DialogContent title={ask.title} closeLabel={t.common.close}>
          <form onSubmit={submit}>
            <Field label={ask.label}>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <DialogFooter>
              <Button onClick={onClose}>{t.common.cancel}</Button>
              <Button type="submit" variant="primary" disabled={!name.trim()}>
                {ask.submit}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

export function Bundles() {
  const { t } = useI18n();
  const s = t.pages.tasks;
  const qc = useQueryClient();
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<Ask | null>(null);
  const bundles = useQuery({
    queryKey: ["bundles"],
    queryFn: () => api<{ items: Bundle[] }>("/v1/bundles"),
  });
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setPicked(new Set());
      toast.success(t.common.saved);
      void qc.invalidateQueries({ queryKey: ["bundles"] });
    },
    onError: (e) => toast.error(t.common.error, errorMessage(e)),
  });

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <section className="space-y-4" aria-label={s.title}>
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-prose text-ui text-muted">{s.description}</p>
        <Button
          disabled={picked.size < 2}
          onClick={() =>
            setAsk({
              title: `Merge ${picked.size} tasks`,
              label: "Name of the merged task",
              submit: "Merge",
              run: (name) =>
                run.mutateAsync(() =>
                  api("/v1/bundles/merge", { json: { bundle_ids: [...picked], name } }),
                ),
            })
          }
        >
          <Merge aria-hidden />
          Merge selected ({picked.size})
        </Button>
      </div>
      {bundles.isPending && <SkeletonList label={t.common.loading} />}
      {bundles.isError && (
        <ErrorBanner
          title={t.common.loadFailed}
          message={errorMessage(bundles.error)}
          onRetry={() => void bundles.refetch()}
          retryLabel={t.common.retry}
        />
      )}
      {bundles.data?.items.length === 0 && (
        <EmptyState icon={Layers} title={s.empty} description={s.emptyHint} />
      )}
      {bundles.data?.items.map((b) => (
        <Card key={b.id} className="p-4">
          <header className="flex flex-wrap items-start gap-3">
            <Checkbox
              className="mt-0.5"
              aria-label={`Select ${b.name}`}
              checked={picked.has(b.id)}
              onCheckedChange={() => toggle(b.id)}
            />
            <div className="min-w-0 flex-1">
              <BundleSummary bundle={b} />
              <p className="mt-1 text-xs text-faint">{b.project}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setAsk({
                  title: "Rename task",
                  label: "New name",
                  initial: b.name,
                  submit: "Rename",
                  run: (name) =>
                    run.mutateAsync(() =>
                      api(`/v1/bundles/${b.id}`, { method: "PATCH", json: { name } }),
                    ),
                })
              }
            >
              <Pencil aria-hidden />
              Rename
            </Button>
          </header>
          <ul className="mt-3 divide-y divide-line border-t border-line text-ui">
            {b.sessions.map((ss) => (
              <li key={ss.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="text-muted">{ss.agent.replace("_", " ")}</span>
                <code className="text-xs text-faint">{ss.agent_session_id.slice(0, 8)}</code>
                {ss.branches.length > 1 && (
                  <span className="text-xs text-muted" title={ss.branches.join(", ")}>
                    {ss.branches.length} branches
                  </span>
                )}
                <span className="text-xs text-faint">
                  {ss.ended_at ? new Date(ss.ended_at).toLocaleString() : ""}
                </span>
                {b.sessions.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() =>
                      setAsk({
                        title: "Split out this session",
                        label: "Name of the new task",
                        submit: "Split out",
                        run: (new_name) =>
                          run.mutateAsync(() =>
                            api(`/v1/bundles/${b.id}/split`, {
                              json: { session_ids: [ss.id], new_name },
                            }),
                          ),
                      })
                    }
                  >
                    <Split aria-hidden />
                    Split out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <NameDialog ask={ask} onClose={() => setAsk(null)} />
    </section>
  );
}
