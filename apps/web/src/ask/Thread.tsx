// The conversation: each question with its automated answer (cited) or refusal (forwardable),
// and the owner's reply when there is one.
import { AutomatedBadge } from "@pama/ui";
import { useState } from "react";
import { type Ask, api } from "./api.ts";
import { t } from "./i18n.ts";

function Feedback({ ask }: { ask: Ask }) {
  const [sent, setSent] = useState(ask.useful !== null && ask.useful !== undefined);
  if (sent) return <p className="text-xs text-stone-400">{t.thanks}</p>;
  const send = async (useful: boolean) => {
    setSent(true);
    await api.feedback(ask.id, useful).catch(() => setSent(false));
  };
  return (
    <div className="flex items-center gap-2 text-xs text-stone-500">
      <span>{t.useful}</span>
      <button
        type="button"
        className="rounded px-1.5 py-0.5 hover:bg-stone-100"
        aria-label="Useful"
        onClick={() => send(true)}
      >
        👍
      </button>
      <button
        type="button"
        className="rounded px-1.5 py-0.5 hover:bg-stone-100"
        aria-label="Not useful"
        onClick={() => send(false)}
      >
        👎
      </button>
    </div>
  );
}

function AskView({
  ask,
  owner,
  onChange,
}: {
  ask: Ask;
  owner: string;
  onChange: (a: Ask) => void;
}) {
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
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-stone-900 px-4 py-2 text-white">
          {ask.question}
        </p>
      </div>
      <div className="max-w-[90%] space-y-2">
        {ask.status === "pending" && (
          <p className="animate-pulse text-sm text-stone-500">{t.asking_now}</p>
        )}
        {ask.answer && (
          <div className="space-y-2 rounded-2xl rounded-bl-sm border border-stone-200 bg-white px-4 py-3">
            <AutomatedBadge owner={owner} />
            <p className="whitespace-pre-wrap leading-relaxed">{ask.answer}</p>
            {!!ask.citations?.length && (
              <p className="flex flex-wrap items-center gap-1 text-xs text-stone-500">
                <span>{t.sources}:</span>
                {ask.citations.map((c, i) => (
                  <span
                    key={c.item_id}
                    className="rounded bg-stone-100 px-1.5 py-0.5"
                    title={c.item_id}
                  >
                    [{i + 1}] {c.label}
                  </span>
                ))}
              </p>
            )}
            {ask.status === "answered" && <Feedback ask={ask} />}
          </div>
        )}
        {(ask.status === "refused" ||
          ask.status === "forwarded" ||
          ask.status === "owner_answered") &&
          !ask.answer && (
            <div className="rounded-2xl rounded-bl-sm border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
              <p>{t.refused[ask.reason ?? "out_of_scope"] ?? t.refused.out_of_scope}</p>
              {ask.status === "refused" && (
                <button type="button" disabled={busy} onClick={forward} className="btn mt-2">
                  {t.forward(owner)}
                </button>
              )}
              {ask.status === "forwarded" && (
                <p className="mt-1 text-stone-600">{t.forwarded(owner)}</p>
              )}
            </div>
          )}
        {ask.owner_reply && (
          <div className="rounded-2xl rounded-bl-sm border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-medium text-emerald-900">{t.ownerReply(owner)}</p>
            <p className="whitespace-pre-wrap">{ask.owner_reply}</p>
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
