// Review queue (US1): read each draft digest, then approve, edit or discard it.
import { useI18n } from "@pama/i18n";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SkeletonList,
  StatusPill,
  Switch,
  Textarea,
  type Tone,
  useConfirm,
  useToast,
} from "@pama/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCheck, Pencil, X } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../lib/api.ts";
import { queries } from "../lib/query.ts";
import type { DigestContent, Draft, Project } from "./types.ts";

const LABEL_TONE: Record<string, Tone> = {
  infra: "accent",
  business_sensitive: "warning",
  customer: "danger",
};

function Labels({ labels }: { labels?: string[] }) {
  if (!labels?.length) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
      {labels.map((l) => (
        <Badge key={l} tone={LABEL_TONE[l] ?? "neutral"}>
          {l.replace("_", " ")}
        </Badge>
      ))}
    </span>
  );
}

function DigestView({ c }: { c: DigestContent }) {
  return (
    <div className="space-y-3 text-sm leading-6">
      <p>
        <span className="font-medium">Goal.</span> {c.goal}
      </p>
      {c.decisions.length > 0 && (
        <ol className="list-decimal space-y-2 pl-5 marker:text-faint">
          {c.decisions.map((d) => (
            <li key={d.id}>
              <span className="font-medium">{d.what}</span>
              <Labels labels={d.labels} />
              {d.why && <div className="text-muted">Why: {d.why}</div>}
              {!!d.alternatives?.length && (
                <div className="text-faint">Rejected: {d.alternatives.join("; ")}</div>
              )}
            </li>
          ))}
        </ol>
      )}
      {c.outcome && (
        <p>
          <span className="font-medium">Outcome.</span> {c.outcome}
        </p>
      )}
      {c.open_items.length > 0 && (
        <p>
          <span className="font-medium">Open.</span> {c.open_items.join(" · ")}
        </p>
      )}
      <p className="text-xs text-muted">
        {c.modules.length > 0 && <>Modules: {c.modules.join(", ")} · </>}
        Removed before digesting: {c.redactions.secret} secret(s), {c.redactions.pii} personal
        item(s)
      </p>
    </div>
  );
}

function DraftCard({ d, onDone }: { d: Draft; onDone: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(d.content, null, 2));
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ path, json }: { path: string; json?: unknown; done: string }) =>
      api(path, { json: json ?? {} }),
    onSuccess: (_r, v) => {
      toast.success(v.done);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function approveEdited() {
    let content: unknown;
    try {
      content = JSON.parse(text);
    } catch {
      setError("The digest is not valid JSON.");
      return;
    }
    setError(null);
    act.mutate({ path: `/v1/digests/${d.id}/approve`, json: { content }, done: "Approved" });
  }

  return (
    <Card>
      <CardHeader
        title={
          <>
            {d.project} <span className="font-normal text-muted">/ {d.bundle}</span>
          </>
        }
        description={
          <>
            {d.content.source.agent.replace("_", " ")}
            {d.device ? ` · from ${d.device}` : ""} · {new Date(d.created_at).toLocaleString()}
          </>
        }
        actions={<StatusPill tone="warning">draft</StatusPill>}
      />
      {editing ? (
        <Textarea
          className="h-80 font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Digest JSON"
        />
      ) : (
        <DigestView c={d.content} />
      )}
      {error && <ErrorBanner className="mt-3" title="Couldn't save" message={error} />}
      <footer className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
        {editing ? (
          <>
            <Button variant="primary" loading={act.isPending} onClick={approveEdited}>
              <Check aria-hidden />
              Approve edited
            </Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              loading={act.isPending}
              onClick={() => act.mutate({ path: `/v1/digests/${d.id}/approve`, done: "Approved" })}
            >
              <Check aria-hidden />
              Approve
            </Button>
            <Button onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              Edit
            </Button>
            <Button
              variant="danger"
              disabled={act.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: "Discard this digest?",
                  description: "It will not be shared or used for answers.",
                  confirmLabel: "Discard",
                  danger: true,
                });
                if (ok) act.mutate({ path: `/v1/digests/${d.id}/discard`, done: "Discarded" });
              }}
            >
              <X aria-hidden />
              Discard
            </Button>
          </>
        )}
      </footer>
    </Card>
  );
}

function AutoApprove({ projects, reload }: { projects: Project[]; reload: () => void }) {
  const toast = useToast();
  if (!projects.length) return null;
  return (
    <Card className="h-fit">
      <CardHeader
        title="Auto-approve"
        description="Off by default: digests stay private until you approve them."
      />
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
                  toast.error("Couldn't change auto-approve", errorMessage(e));
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
  const reload = () => {
    void qc.invalidateQueries({ queryKey: queries.review.queryKey });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };

  return (
    <>
      <PageHeader title={t.pages.review.title} description={t.pages.review.description} />
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
          {drafts.data?.items.length === 0 && (
            <EmptyState
              icon={ClipboardCheck}
              title={t.pages.review.empty}
              description={t.pages.review.emptyHint}
            />
          )}
          {drafts.data?.items.map((d) => (
            <DraftCard key={d.id} d={d} onDone={reload} />
          ))}
        </section>
        <AutoApprove projects={projects.data?.items ?? []} reload={reload} />
      </div>
    </>
  );
}
