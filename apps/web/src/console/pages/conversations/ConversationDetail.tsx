// One conversation as a thread (spec 008, US3): each question with its status, the answer the
// asker saw and its citations, the owner's reply; an inline reply composer with "Suggest a reply"
// (the old Inbox flow: nothing is sent without the owner), archive, delete and export.
import { useI18n } from "@pama/i18n";
import {
  AutomatedBadge,
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  PageHeader,
  Skeleton,
  StatusPill,
  Textarea,
  useConfirm,
  useToast,
} from "@pama/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BadgeCheck,
  MessageSquareReply,
  MessagesSquare,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { errorMessage, isApiError } from "../../../lib/api.ts";
import { queries } from "../../../lib/query.ts";
import { type ConversationDetail, conversationApi, convKeys, type Turn } from "./api.ts";
import { CitationChips, TurnStatus } from "./parts.tsx";

const when = (d: string) => new Date(d).toLocaleString();

/** Turns the owner can still reply to (same rule as the server's reply route). */
const replyable = (t: Turn) =>
  t.status === "forwarded" || t.status === "refused" || t.status === "owner_answered";

function Suggestion({ turn, onUse }: { turn: Turn; onUse: (text: string) => void }) {
  const { t } = useI18n();
  const s = t.convo.detail;
  const [text, setText] = useState(turn.suggestion);
  const [state, setState] = useState<"idle" | "loading" | "none" | "error">("idle");
  const suggest = async () => {
    setState("loading");
    try {
      const r = await conversationApi.suggest(turn.id);
      setText(r.suggestion);
      setState(r.suggestion ? "idle" : "none");
    } catch {
      setState("error");
    }
  };
  if (!text) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-ui text-muted" aria-live="polite">
        <Button size="sm" loading={state === "loading"} onClick={() => void suggest()}>
          {state !== "loading" && <Sparkles aria-hidden />}
          {state === "loading" ? s.suggesting : s.suggest}
        </Button>
        {state === "none" && <span>{s.noSuggestion}</span>}
        {state === "error" && <span className="text-danger-ink">{s.suggestFailed}</span>}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-control border border-line bg-accent-soft/50 p-3 text-ui">
      <p className="flex items-center gap-1.5 text-xs font-medium text-accent-ink">
        <Sparkles aria-hidden className="size-3.5" />
        {s.suggestion}
      </p>
      <p className="whitespace-pre-wrap text-fg">{text}</p>
      <Button size="sm" onClick={() => onUse(text)}>
        {s.useSuggestion}
      </Button>
    </div>
  );
}

function Composer({ conv, turn }: { conv: ConversationDetail; turn: Turn }) {
  const { t } = useI18n();
  const s = t.convo.detail;
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const done = () => {
    void qc.invalidateQueries({ queryKey: convKeys.all });
    void qc.invalidateQueries({ queryKey: queries.inbox.queryKey });
  };
  const reply = useMutation({
    mutationFn: () => conversationApi.reply(conv.id, text.trim(), turn.id),
    onSuccess: () => {
      toast.success(s.sent);
      setText("");
      done();
    },
    onError: (e) => toast.error(s.sendFailed, errorMessage(e)),
  });
  const dismiss = useMutation({
    mutationFn: () => conversationApi.dismiss(turn.id),
    onSuccess: () => {
      toast.success(s.dismissed);
      done();
    },
    onError: (e) => toast.error(s.actionFailed, errorMessage(e)),
  });
  return (
    <form
      className="space-y-3 rounded-card border border-line bg-subtle/40 p-3"
      aria-label={s.replyTo}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) reply.mutate();
      }}
    >
      {turn.status !== "owner_answered" && <Suggestion turn={turn} onUse={setText} />}
      <Field label={s.yourReply} hint={s.replyHint}>
        <Textarea
          rows={3}
          maxLength={5000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={!text.trim()} loading={reply.isPending}>
          {!reply.isPending && <Send aria-hidden />}
          {s.send}
        </Button>
        {turn.status === "forwarded" && (
          <Button
            disabled={reply.isPending}
            loading={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            {s.dismiss}
          </Button>
        )}
      </div>
    </form>
  );
}

function TurnView({ conv, turn, owner }: { conv: ConversationDetail; turn: Turn; owner: string }) {
  const { t } = useI18n();
  const s = t.convo.detail;
  const [replying, setReplying] = useState(turn.status === "forwarded");
  const shownAnswer = turn.status === "answered" || turn.status === "drafted";
  return (
    <li className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <TurnStatus status={turn.status} replied={!!turn.owner_reply} />
        <time dateTime={turn.created_at}>{when(turn.created_at)}</time>
        {turn.useful === true && (
          <Badge tone="success">
            <ThumbsUp aria-hidden />
            {s.useful}
          </Badge>
        )}
        {turn.useful === false && (
          <Badge>
            <ThumbsDown aria-hidden />
            {s.notUseful}
          </Badge>
        )}
      </div>
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-card rounded-br-sm bg-accent-soft px-4 py-2.5 text-sm leading-6 text-fg">
          <span className="sr-only">{s.asker}: </span>
          {turn.question}
        </p>
      </div>
      <div className="max-w-[92%] space-y-2">
        {shownAnswer && turn.answer ? (
          <div className="space-y-3 rounded-card rounded-bl-sm border border-line bg-surface px-4 py-3">
            <AutomatedBadge owner={owner} label={s.automated} />
            <p className="whitespace-pre-wrap text-sm leading-6">{turn.answer}</p>
            <CitationChips citations={turn.citations} />
          </div>
        ) : (
          <p className="rounded-card rounded-bl-sm border border-transparent bg-warning-soft px-4 py-3 text-sm text-warning-ink">
            <span className="font-medium">{s.reason}: </span>
            {t.ask.refused[turn.reason ?? ""] ?? turn.reason ?? s.noAnswer}
          </p>
        )}
        {turn.owner_reply && (
          <div className="rounded-card rounded-bl-sm border border-transparent bg-success-soft px-4 py-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-success-ink">
              <MessageSquareReply aria-hidden className="size-3.5" />
              {s.ownerReply}
              {turn.owner_replied_at && (
                <time className="font-normal" dateTime={turn.owner_replied_at}>
                  · {when(turn.owner_replied_at)}
                </time>
              )}
            </p>
            <p className="whitespace-pre-wrap text-sm leading-6">{turn.owner_reply}</p>
          </div>
        )}
        {conv.origin === "link" &&
          replyable(turn) &&
          (replying ? (
            <Composer conv={conv} turn={turn} />
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
              <MessageSquareReply aria-hidden />
              {s.reply}
            </Button>
          ))}
      </div>
    </li>
  );
}

function DetailSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-4">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-5/6" />
    </div>
  );
}

export function ConversationDetailPage() {
  const { t } = useI18n();
  const s = t.convo.detail;
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const conv = useQuery({ queryKey: convKeys.detail(id), queryFn: () => conversationApi.get(id) });
  const archive = useMutation({
    mutationFn: (status: "open" | "archived") => conversationApi.patch(id, { status }),
    onSuccess: (_r, status) => {
      toast.success(status === "archived" ? s.archivedToast : s.reopenedToast);
      void qc.invalidateQueries({ queryKey: convKeys.all });
    },
    onError: (e) => toast.error(s.actionFailed, errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => conversationApi.remove(id),
    onSuccess: () => {
      toast.success(s.deletedToast);
      qc.removeQueries({ queryKey: convKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: convKeys.all });
      void qc.invalidateQueries({ queryKey: queries.inbox.queryKey });
      void navigate({ to: "/conversations" });
    },
    onError: (e) => toast.error(s.actionFailed, errorMessage(e)),
  });

  const back = (
    <Link to="/conversations" className={`${buttonClass("ghost", "sm")} -ml-2 mb-3`}>
      <ArrowLeft aria-hidden />
      {s.back}
    </Link>
  );

  if (conv.isPending) {
    return (
      <>
        {back}
        <DetailSkeleton label={t.common.loading} />
      </>
    );
  }
  if (conv.isError) {
    return (
      <>
        {back}
        {isApiError(conv.error, 404) ? (
          <EmptyState icon={MessagesSquare} title={s.notFound} />
        ) : (
          <ErrorBanner
            title={t.common.loadFailed}
            message={errorMessage(conv.error)}
            onRetry={() => void conv.refetch()}
            retryLabel={t.common.retry}
          />
        )}
      </>
    );
  }
  const c = conv.data;
  const archived = c.status === "archived";
  return (
    <>
      {back}
      <PageHeader
        title={c.title || t.convo.list.untitled}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {c.origin === "link"
                ? (c.link_title ?? c.link_slug ?? t.convo.list.link)
                : t.convo.origin[c.origin]}
            </span>
            <span aria-hidden>·</span>
            {c.asker_email ? (
              <Badge tone="success">
                <BadgeCheck aria-hidden />
                {c.asker_email}
              </Badge>
            ) : (
              c.origin === "link" && <span>{t.convo.list.anonymous}</span>
            )}
            <span>{s.started(when(c.created_at))}</span>
            {archived && (
              <StatusPill tone="neutral" icon={Archive}>
                {t.convo.list.archived}
              </StatusPill>
            )}
          </span>
        }
        actions={
          <>
            <Button
              size="sm"
              loading={archive.isPending}
              onClick={() => archive.mutate(archived ? "open" : "archived")}
            >
              {!archive.isPending &&
                (archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />)}
              {archived ? s.unarchive : s.archive}
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={remove.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: s.deleteTitle,
                  description: s.deleteBody,
                  confirmLabel: s.delete,
                  danger: true,
                });
                if (ok) remove.mutate();
              }}
            >
              {!remove.isPending && <Trash2 aria-hidden />}
              {s.delete}
            </Button>
          </>
        }
      />
      <Card className="p-4 sm:p-6">
        {c.turns.length === 0 ? (
          <EmptyState icon={MessagesSquare} title={t.convo.list.empty} />
        ) : (
          <ol className="space-y-8" aria-label={c.title || t.convo.list.untitled}>
            {c.turns.map((turn) => (
              <TurnView key={turn.id} conv={c} turn={turn} owner={t.convo.detail.automated} />
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
