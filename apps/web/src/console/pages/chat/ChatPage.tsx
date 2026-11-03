// Chat (spec 008, US4): the owner asks their own agent over all approved work or a chosen scope,
// multi-turn, through the same answer pipeline as Ask Links. Chats are listed on the side; the
// scope is fixed once a chat starts; "Create Ask Link from this chat" shares the chat's scope.
import { useI18n } from "@pama/i18n";
import {
  Button,
  buttonClass,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Notice,
  PageHeader,
  Skeleton,
  SkeletonList,
  Spinner,
  Textarea,
  useToast,
} from "@pama/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowUp,
  Check,
  CircleHelp,
  Copy,
  Link2,
  MessageCircle,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../../lib/api.ts";
import { conversationApi, convKeys, type SourceRef, type Turn } from "../conversations/api.ts";
import { CitationChips } from "../conversations/parts.tsx";
import { type CreatedLink, chatApi, chatKeys, scopeOptions } from "./api.ts";
import { ScopeCombobox } from "./ScopeCombobox.tsx";

/** `/chat?c=<conversation id>`. */
export function chatSearch(s: Record<string, unknown>): { c?: string } {
  return typeof s.c === "string" && s.c ? { c: s.c } : {};
}

function ChatList({ current, onPick }: { current?: string; onPick: () => void }) {
  const { t } = useI18n();
  const s = t.convo.chat;
  const list = useQuery({ queryKey: chatKeys.list, queryFn: chatApi.list });
  return (
    <nav aria-label={s.history} className="space-y-2">
      <Link
        to="/chat"
        search={{}}
        onClick={onPick}
        className={cn(buttonClass("secondary"), "w-full justify-start")}
      >
        <Plus aria-hidden />
        {s.newChat}
      </Link>
      {list.isPending && <SkeletonList rows={3} label={t.common.loading} />}
      {list.isError && (
        <ErrorBanner
          title={t.common.loadFailed}
          message={errorMessage(list.error)}
          onRetry={() => void list.refetch()}
          retryLabel={t.common.retry}
        />
      )}
      {list.data?.items.length === 0 && <p className="px-2 text-ui text-muted">{s.noChats}</p>}
      {!!list.data?.items.length && (
        <ul className="space-y-0.5">
          {list.data.items.map((c) => (
            <li key={c.id}>
              <Link
                to="/chat"
                search={{ c: c.id }}
                onClick={onPick}
                aria-current={c.id === current ? "page" : undefined}
                className={cn(
                  "block rounded-control px-2.5 py-1.5 text-ui transition-colors",
                  c.id === current
                    ? "bg-accent-soft text-accent-ink"
                    : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <span className="block truncate font-medium">
                  {c.title || t.convo.list.untitled}
                </span>
                <span className="block text-xs text-faint">
                  {new Date(c.last_at).toLocaleDateString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

function ChatTurn({
  turn,
}: {
  turn: Pick<Turn, "question" | "status" | "answer" | "reason" | "citations">;
}) {
  const { t } = useI18n();
  return (
    <li className="space-y-2">
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-card rounded-br-sm bg-accent px-4 py-2.5 text-sm leading-6 text-accent-contrast">
          <span className="sr-only">{t.ask.you}: </span>
          {turn.question}
        </p>
      </div>
      <div className="max-w-[92%]">
        {turn.answer && (turn.status === "answered" || turn.status === "drafted") ? (
          <div className="space-y-3 rounded-card rounded-bl-sm border border-line bg-surface px-4 py-3">
            <p className="whitespace-pre-wrap text-sm leading-6">{turn.answer}</p>
            <CitationChips citations={turn.citations} />
          </div>
        ) : (
          <p className="flex items-start gap-2 rounded-card rounded-bl-sm bg-warning-soft px-4 py-3 text-sm text-warning-ink">
            <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t.desktop.refused[turn.reason ?? ""] ?? t.desktop.refused.out_of_scope}
          </p>
        )}
      </div>
    </li>
  );
}

function LinkDialog({ link, onClose }: { link: CreatedLink | null; onClose: () => void }) {
  const { t } = useI18n();
  const s = t.convo.chat;
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={link !== null} onOpenChange={(o) => !o && onClose()}>
      {link && (
        <DialogContent title={s.linkCreated} closeLabel={t.common.close}>
          <div className="space-y-3">
            <Field label={s.linkUrl}>
              <Input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
            </Field>
            {link.pin && (
              <Field label={s.linkPin} hint={s.linkPinHint}>
                <Input readOnly value={link.pin} className="font-mono tracking-widest" />
              </Field>
            )}
          </div>
          <DialogFooter>
            <Link to="/links" className={buttonClass("ghost")}>
              {s.openLinks}
            </Link>
            <Button
              variant="primary"
              onClick={async () => {
                await navigator.clipboard?.writeText(link.url).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? s.copied : s.copy}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

export function ChatPage() {
  const { t } = useI18n();
  const s = t.convo.chat;
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { c: current } = chatSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<SourceRef[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<CreatedLink | null>(null);
  const [showList, setShowList] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const conv = useQuery({
    queryKey: convKeys.detail(current ?? ""),
    queryFn: () => conversationApi.get(current ?? ""),
    enabled: !!current,
  });
  const options = useQuery({
    queryKey: chatKeys.scopes,
    queryFn: () => scopeOptions({ projects: s.projects, tasks: s.tasks }),
    staleTime: 60_000,
  });

  // A new chat starts with an empty scope; reset the composer when switching chats.
  useEffect(() => {
    setError(null);
    setPending(null);
    if (!current) setScope([]);
  }, [current]);

  const turns = conv.data?.turns ?? [];
  const count = turns.length + (pending ? 1 : 0);
  useEffect(() => {
    if (count) bottom.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [count]);

  const send = useMutation({
    mutationFn: (q: string) => chatApi.send(q, current ? { conversation_id: current } : { scope }),
    onMutate: (q) => {
      setPending(q);
      setError(null);
      setQuestion("");
    },
    onSuccess: async (r) => {
      // Load the thread with the new turn before the pending bubble goes away.
      await qc
        .fetchQuery({
          queryKey: convKeys.detail(r.conversation_id),
          queryFn: () => conversationApi.get(r.conversation_id),
          staleTime: 0,
        })
        .catch(() => undefined);
      void qc.invalidateQueries({ queryKey: chatKeys.list });
      setPending(null);
      if (r.conversation_id !== current)
        void navigate({ to: "/chat", search: { c: r.conversation_id } });
    },
    onError: (e, q) => {
      setPending(null);
      setQuestion(q);
      setError(errorMessage(e));
    },
  });
  const makeLink = useMutation({
    mutationFn: () => chatApi.createLink(current ?? ""),
    onSuccess: (l) => setLink(l),
    onError: (e) => toast.error(s.linkFailed, errorMessage(e)),
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = question.trim();
    if (q && !send.isPending) send.mutate(q);
  };
  const fixedScope = current ? (conv.data?.scope ?? []) : scope;

  return (
    <>
      <PageHeader
        title={s.title}
        description={s.description}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              className="lg:hidden"
              aria-expanded={showList}
              onClick={() => setShowList((x) => !x)}
            >
              <PanelLeftOpen aria-hidden />
              {s.showHistory}
            </Button>
            <Button
              size="sm"
              disabled={!current || !turns.length}
              loading={makeLink.isPending}
              onClick={() => makeLink.mutate()}
            >
              {!makeLink.isPending && <Link2 aria-hidden />}
              {s.createLink}
            </Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className={cn("lg:block", showList ? "block" : "hidden")}>
          <ChatList current={current} onPick={() => setShowList(false)} />
        </aside>

        <section
          aria-label={s.title}
          className="flex min-h-[60vh] flex-col rounded-card border border-line bg-surface"
        >
          <div className="space-y-2 border-b border-line p-3 sm:p-4">
            <ScopeCombobox
              multiple
              label={s.scope}
              placeholder={fixedScope.length ? s.scopeSearch : `${s.scopeAll} · ${s.scopeSearch}`}
              emptyLabel={s.scopeNone}
              removeLabel={s.remove}
              options={options.data ?? []}
              value={fixedScope}
              onChange={setScope}
              disabled={!!current}
            />
            {current && <p className="text-xs text-muted">{s.scopeFixed}</p>}
            {options.isError && (
              <ErrorBanner
                title={t.common.loadFailed}
                message={errorMessage(options.error)}
                onRetry={() => void options.refetch()}
                retryLabel={t.common.retry}
              />
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4" aria-live="polite">
            {current && conv.isPending && (
              <div role="status" aria-label={t.common.loading} className="space-y-3">
                <Skeleton className="ml-auto h-8 w-1/2" />
                <Skeleton className="h-16 w-3/4" />
              </div>
            )}
            {current && conv.isError && (
              <ErrorBanner
                title={t.common.loadFailed}
                message={errorMessage(conv.error)}
                onRetry={() => void conv.refetch()}
                retryLabel={t.common.retry}
              />
            )}
            {!current && !pending && (
              <EmptyState icon={MessageCircle} title={s.emptyTitle} description={s.emptyHint} />
            )}
            {(turns.length > 0 || pending) && (
              <ol className="space-y-6">
                {turns.map((turn) => (
                  <ChatTurn key={turn.id} turn={turn} />
                ))}
                {pending && (
                  <li className="space-y-2">
                    <div className="flex justify-end">
                      <p className="max-w-[85%] whitespace-pre-wrap rounded-card rounded-br-sm bg-accent px-4 py-2.5 text-sm leading-6 text-accent-contrast">
                        {pending}
                      </p>
                    </div>
                    <p className="inline-flex items-center gap-2 text-sm text-muted">
                      <Spinner size="sm" label={null} />
                      {s.thinking}
                    </p>
                  </li>
                )}
              </ol>
            )}
            <div ref={bottom} />
          </div>

          <div className="border-t border-line p-3 sm:p-4">
            {error && (
              <Notice tone="warning" className="mb-2">{`${s.sendFailed}: ${error}`}</Notice>
            )}
            <form
              onSubmit={submit}
              className="flex items-end gap-2 rounded-card border border-line bg-surface p-1.5 transition-colors focus-within:border-ring"
            >
              <Textarea
                className="max-h-40 min-h-10 flex-1 resize-none border-0 bg-transparent text-base hover:border-0 focus-visible:outline-none sm:text-sm"
                rows={1}
                maxLength={2000}
                placeholder={s.placeholder}
                aria-label={s.placeholder}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              <Button
                type="submit"
                variant="primary"
                size="icon"
                className="size-10"
                aria-label={s.send}
                loading={send.isPending}
                disabled={!question.trim()}
              >
                {!send.isPending && <ArrowUp aria-hidden />}
              </Button>
            </form>
          </div>
        </section>
      </div>
      <LinkDialog link={link} onClose={() => setLink(null)} />
    </>
  );
}
