// Forwarded questions: reply (shown on the link page, emailed to verified askers) or dismiss.
// Each one can carry the reply the agent would have given; "Use this reply" puts it in the box
// to edit before sending — nothing is sent without the owner. Lives at /conversations until the
// Conversations page of spec 008 makes it one of its filters.
import { useI18n } from "@pama/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  PageHeader,
  SkeletonList,
  Textarea,
  useToast,
} from "@pama/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, MessagesSquare, Send, Sparkles } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../lib/api.ts";
import { queries } from "../lib/query.ts";

interface Item {
  id: string;
  question: string;
  link_title: string | null;
  asker_email: string | null;
  asker_verified: boolean;
  created_at: string;
  suggestion: string | null;
}

function Suggestion({ item, onUse }: { item: Item; onUse: (text: string) => void }) {
  const [text, setText] = useState(item.suggestion);
  const [state, setState] = useState<"idle" | "loading" | "none" | "error">("idle");
  const suggest = async () => {
    setState("loading");
    try {
      const r = await api<{ suggestion: string | null }>(`/v1/asks/${item.id}/suggest`, {
        json: {},
      });
      setText(r.suggestion);
      setState(r.suggestion ? "idle" : "none");
    } catch {
      setState("error");
    }
  };
  if (!text) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-ui text-muted">
        <Button size="sm" loading={state === "loading"} onClick={() => void suggest()}>
          <Sparkles aria-hidden />
          {state === "loading" ? "Thinking…" : "Suggest a reply"}
        </Button>
        {state === "none" && <span>Your notes don't cover this — write the reply yourself.</span>}
        {state === "error" && <span className="text-danger-ink">Couldn't get a suggestion.</span>}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-control border border-line bg-accent-soft/50 p-3 text-ui">
      <p className="flex items-center gap-1.5 text-xs font-medium text-accent-ink">
        <Sparkles aria-hidden className="size-3.5" />
        AI suggested reply
      </p>
      <p className="whitespace-pre-wrap text-fg">{text}</p>
      <Button size="sm" onClick={() => onUse(text)}>
        Use this reply
      </Button>
    </div>
  );
}

function Reply({ item, onDone }: { item: Item; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const act = useMutation({
    mutationFn: (v: { path: string; json: unknown; done: string }) => api(v.path, { json: v.json }),
    onSuccess: (_r, v) => {
      toast.success(v.done);
      onDone();
    },
    onError: (e) => toast.error("Couldn't send", errorMessage(e)),
  });
  return (
    <Card className="space-y-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span>{item.link_title ?? "Ask Link"}</span>
        <span aria-hidden>·</span>
        {item.asker_verified ? (
          <Badge tone="success">
            <BadgeCheck aria-hidden />
            {item.asker_email}
          </Badge>
        ) : (
          <span>anonymous</span>
        )}
        <span aria-hidden>·</span>
        <span>{new Date(item.created_at).toLocaleString()}</span>
      </p>
      <p className="text-sm font-medium">{item.question}</p>
      <Suggestion item={item} onUse={setText} />
      <Field label="Your reply">
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!text.trim()}
          loading={act.isPending && act.variables?.done === "Reply sent"}
          onClick={() =>
            act.mutate({ path: `/v1/asks/${item.id}/reply`, json: { text }, done: "Reply sent" })
          }
        >
          <Send aria-hidden />
          Reply
        </Button>
        <Button
          disabled={act.isPending}
          onClick={() =>
            act.mutate({ path: `/v1/asks/${item.id}/dismiss`, json: {}, done: "Dismissed" })
          }
        >
          Dismiss
        </Button>
      </div>
    </Card>
  );
}

export function Inbox() {
  const { t } = useI18n();
  const s = t.pages.conversations;
  const qc = useQueryClient();
  const items = useQuery({
    ...queries.inbox,
    queryFn: () => api<{ items: Item[] }>("/v1/inbox"),
  });
  const reload = () => void qc.invalidateQueries({ queryKey: queries.inbox.queryKey });
  return (
    <>
      <PageHeader title={s.title} description={s.description} />
      <section className="space-y-4" aria-label={s.title}>
        {items.isPending && <SkeletonList label={t.common.loading} />}
        {items.isError && (
          <ErrorBanner
            title={t.common.loadFailed}
            message={errorMessage(items.error)}
            onRetry={() => void items.refetch()}
            retryLabel={t.common.retry}
          />
        )}
        {items.data?.items.length === 0 && (
          <EmptyState icon={MessagesSquare} title={s.empty} description={s.emptyHint} />
        )}
        {items.data?.items.map((i) => (
          <Reply key={i.id} item={i} onDone={reload} />
        ))}
      </section>
    </>
  );
}
