// Forwarded questions: reply (shown on the link page, emailed to verified askers) or dismiss.
// Each one can carry the reply the agent would have given; "Use this reply" puts it in the box
// to edit before sending — nothing is sent without the owner.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";

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
      <div className="flex items-center gap-2 text-xs text-stone-500">
        <button
          type="button"
          className="btn"
          disabled={state === "loading"}
          onClick={() => void suggest()}
        >
          {state === "loading" ? "Thinking…" : "Suggest a reply"}
        </button>
        {state === "none" && <span>Your notes don't cover this — write the reply yourself.</span>}
        {state === "error" && <span className="text-red-700">Couldn't get a suggestion.</span>}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded border border-sky-200 bg-sky-50 p-3 text-sm">
      <p className="text-xs font-medium text-sky-900">AI suggested reply</p>
      <p className="whitespace-pre-wrap text-stone-800">{text}</p>
      <button type="button" className="btn" onClick={() => onUse(text)}>
        Use this reply
      </button>
    </div>
  );
}

function Reply({ item, onDone }: { item: Item; onDone: () => void }) {
  const [text, setText] = useState("");
  return (
    <article className="space-y-2 rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-xs text-stone-500">
        {item.link_title ?? "Ask Link"} · {item.asker_verified ? item.asker_email : "anonymous"} ·{" "}
        {new Date(item.created_at).toLocaleString()}
      </p>
      <p className="font-medium">{item.question}</p>
      <Suggestion item={item} onUse={setText} />
      <textarea
        className="w-full rounded border border-stone-300 p-2 text-sm"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Reply"
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!text.trim()}
          onClick={async () => {
            await api(`/v1/asks/${item.id}/reply`, { json: { text } });
            onDone();
          }}
        >
          Reply
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            await api(`/v1/asks/${item.id}/dismiss`, { json: {} });
            onDone();
          }}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}

export function Inbox() {
  const [items, setItems] = useState<Item[] | null>(null);
  const load = useCallback(
    async () => setItems((await api<{ items: Item[] }>("/v1/inbox")).items),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Inbox</h2>
      {items?.length === 0 && <p className="text-sm text-stone-500">No forwarded questions.</p>}
      {items?.map((i) => (
        <Reply key={i.id} item={i} onDone={load} />
      ))}
    </section>
  );
}
