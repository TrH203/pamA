// Forwarded questions: reply (shown on the link page, emailed to verified askers) or dismiss.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";

interface Item {
  id: string;
  question: string;
  link_title: string | null;
  asker_email: string | null;
  asker_verified: boolean;
  created_at: string;
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
