import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AccessGate } from "./AccessGate.tsx";
import { type Ask, api, type Meta, PublicError } from "./api.ts";
import { t } from "./i18n.ts";
import { Thread } from "./Thread.tsx";

type State =
  | { kind: "loading" }
  | { kind: "gate"; mode: string }
  | { kind: "inactive" }
  | { kind: "offline" }
  | { kind: "ready"; meta: Meta };

const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString() : "");

export function AskPage() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [asks, setAsks] = useState<Ask[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const meta = await api.meta();
      setState({ kind: "ready", meta });
      const mine = await api.asks();
      setAsks(mine.items.slice().reverse());
    } catch (e) {
      if (e instanceof PublicError && e.status === 401)
        setState({ kind: "gate", mode: e.access ?? "pin" });
      else if (e instanceof PublicError && (e.status === 410 || e.status === 404))
        setState({ kind: "inactive" });
      else setState({ kind: "offline" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Owner replies arrive asynchronously: poll while something is forwarded.
  useEffect(() => {
    if (!asks.some((a) => a.status === "forwarded")) return;
    const id = setInterval(async () => {
      const mine = await api.asks().catch(() => null);
      if (mine) setAsks(mine.items.slice().reverse());
    }, 15_000);
    return () => clearInterval(id);
  }, [asks]);

  // Scroll to the newest message whenever one is added.
  const count = asks.length;
  useEffect(() => {
    if (count) bottom.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [count]);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const temp: Ask = { id: `pending-${Date.now()}`, question: text, status: "pending" };
    setAsks((xs) => [...xs, temp]);
    setQuestion("");
    try {
      const r = await api.ask(text);
      setAsks((xs) =>
        xs.map((a) =>
          a.id === temp.id
            ? {
                id: r.ask_id,
                question: text,
                status: r.status,
                answer: r.answer ?? null,
                reason: r.reason ?? null,
                citations: r.citations,
                useful: null,
              }
            : a,
        ),
      );
    } catch (e) {
      setAsks((xs) => xs.filter((a) => a.id !== temp.id));
      setQuestion(text);
      if (e instanceof PublicError && e.status === 429) setError(t.rateLimited);
      else if (e instanceof PublicError && e.status === 410) setState({ kind: "inactive" });
      else if (state.kind === "ready") setError(t.offline(state.meta.owner));
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") return <p className="mt-24 text-center text-stone-500">…</p>;
  if (state.kind === "gate") return <AccessGate mode={state.mode} onGranted={load} />;
  if (state.kind === "inactive" || state.kind === "offline") {
    return (
      <section className="mx-auto mt-24 max-w-sm text-center">
        <h1 className="text-lg font-semibold">
          {state.kind === "inactive" ? t.inactive : t.offline("The owner")}
        </h1>
        {state.kind === "inactive" && <p className="mt-2 text-stone-600">{t.inactiveHint}</p>}
      </section>
    );
  }

  const { meta } = state;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };
  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4">
      <header className="border-b border-stone-200 py-5">
        <p className="text-sm text-stone-500">{t.asking(meta.owner)}</p>
        <h1 className="text-xl font-semibold">{meta.title}</h1>
        <p className="mt-2 text-sm text-stone-600">{t.automated(meta.owner)}</p>
        {meta.coverage.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-stone-600">{t.covers}</summary>
            <ul className="mt-2 space-y-1">
              {meta.coverage.map((c) => (
                <li key={`${c.project}/${c.bundle}`} className="text-stone-700">
                  <span className="font-medium">{c.bundle}</span>
                  <span className="text-stone-500">
                    {" "}
                    · {c.project} · {t.sessions(c.sessions)}
                    {c.to ? ` · ${fmt(c.from)} – ${fmt(c.to)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </header>

      <main className="flex-1 space-y-6 py-6">
        {asks.length === 0 && meta.suggested_questions.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-stone-500">{t.suggested}</h2>
            <div className="flex flex-wrap gap-2">
              {meta.suggested_questions.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void ask(q)}
                  className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-left text-sm hover:border-stone-900"
                >
                  {q}
                </button>
              ))}
            </div>
          </section>
        )}
        <Thread
          asks={asks}
          owner={meta.owner}
          onChange={(a) => setAsks((xs) => xs.map((x) => (x.id === a.id ? a : x)))}
        />
        <div ref={bottom} />
      </main>

      <footer className="sticky bottom-0 bg-stone-50 pb-4 pt-2">
        {error && <p className="mb-2 text-sm text-red-700">{error}</p>}
        <form onSubmit={submit} className="flex gap-2">
          <textarea
            className="min-h-[2.75rem] flex-1 resize-none rounded-xl border border-stone-300 bg-white px-3 py-2 focus:border-stone-900 focus:outline-none"
            rows={1}
            maxLength={2000}
            placeholder={t.placeholder}
            aria-label={t.placeholder}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(question);
              }
            }}
          />
          <button
            type="submit"
            disabled={busy || !question.trim()}
            className="btn-primary rounded-xl px-4"
          >
            {t.ask}
          </button>
        </form>
        {meta.footer && (
          <p className="mt-3 text-center text-xs text-stone-400">
            <a href="https://github.com/TrH203/pama" className="hover:underline" rel="noopener">
              {t.footer}
            </a>
          </p>
        )}
      </footer>
    </div>
  );
}
