// The conversation: each question with its automated answer (cited) or refusal (forwardable),
// and the owner's reply when there is one.
import { useI18n } from "@pama/i18n";
import { AutomatedBadge, Badge, Button, Spinner } from "@pama/ui";
import { CircleHelp, Forward, MessageSquareReply, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { type Ask, api } from "./api.ts";

function Feedback({ ask }: { ask: Ask }) {
  const { t } = useI18n();
  const [sent, setSent] = useState(ask.useful !== null && ask.useful !== undefined);
  if (sent) return <p className="text-xs text-faint">{t.ask.thanks}</p>;
  const send = async (useful: boolean) => {
    setSent(true);
    await api.feedback(ask.id, useful).catch(() => setSent(false));
  };
  return (
    <div className="flex items-center gap-1 text-xs text-muted">
      <span className="mr-1">{t.ask.useful}</span>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t.ask.usefulYes}
        onClick={() => send(true)}
      >
        <ThumbsUp aria-hidden />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t.ask.usefulNo}
        onClick={() => send(false)}
      >
        <ThumbsDown aria-hidden />
      </Button>
    </div>
  );
}

const bubble = "rounded-card border px-4 py-3";

function AskView({
  ask,
  owner,
  onChange,
}: {
  ask: Ask;
  owner: string;
  onChange: (a: Ask) => void;
}) {
  const { t: all } = useI18n();
  const t = all.ask;
  const [busy, setBusy] = useState(false);
  const forward = async () => {
    setBusy(true);
    try {
      await api.forward(ask.id);
      onChange({ ...ask, status: "forwarded" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="space-y-3">
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-card rounded-br-sm bg-accent px-4 py-2.5 text-sm leading-6 text-accent-contrast">
          <span className="sr-only">{t.you}: </span>
          {ask.question}
        </p>
      </div>
      <div className="max-w-[92%] space-y-2">
        {ask.status === "pending" && (
          <p className="inline-flex items-center gap-2 text-sm text-muted">
            <Spinner size="sm" label={null} />
            {t.asking_now}
          </p>
        )}
        {ask.answer && (
          <div className={`${bubble} space-y-3 rounded-bl-sm border-line bg-surface`}>
            <AutomatedBadge owner={owner} label={t.automatedBadge(owner)} />
            <p className="whitespace-pre-wrap text-sm leading-6">{ask.answer}</p>
            {!!ask.citations?.length && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span>{t.sources}:</span>
                {ask.citations.map((c, i) => (
                  <Badge key={c.item_id} title={c.item_id}>
                    [{i + 1}] {c.label}
                  </Badge>
                ))}
              </div>
            )}
            {ask.status === "answered" && <Feedback ask={ask} />}
          </div>
        )}
        {(ask.status === "refused" ||
          ask.status === "forwarded" ||
          ask.status === "owner_answered") &&
          !ask.answer && (
            <div
              className={`${bubble} space-y-2 rounded-bl-sm border-transparent bg-warning-soft text-sm text-warning-ink`}
            >
              <p className="flex items-start gap-2">
                <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{t.refused[ask.reason ?? "out_of_scope"] ?? t.refused.out_of_scope}</span>
              </p>
              {ask.status === "refused" && (
                <Button size="sm" loading={busy} onClick={forward}>
                  <Forward aria-hidden />
                  {t.forward(owner)}
                </Button>
              )}
              {ask.status === "forwarded" && <p className="pl-6">{t.forwarded(owner)}</p>}
            </div>
          )}
        {ask.owner_reply && (
          <div className={`${bubble} rounded-bl-sm border-transparent bg-success-soft`}>
            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-success-ink">
              <MessageSquareReply aria-hidden className="size-3.5" />
              {t.ownerReply(owner)}
            </p>
            <p className="whitespace-pre-wrap text-sm leading-6">{ask.owner_reply}</p>
          </div>
        )}
      </div>
    </li>
  );
}

export function Thread({
  asks,
  owner,
  onChange,
}: {
  asks: Ask[];
  owner: string;
  onChange: (a: Ask) => void;
}) {
  if (!asks.length) return null;
  return (
    <ol className="space-y-6" aria-live="polite">
      {asks.map((a) => (
        <AskView key={a.id} ask={a} owner={owner} onChange={onChange} />
      ))}
    </ol>
  );
}
