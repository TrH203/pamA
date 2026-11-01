import { LOCALES, type Locale, useI18n } from "@pama/i18n";
import { Button, ErrorBanner, Skeleton, Textarea } from "@pama/ui";
import { ArrowUp, ChevronDown, Link2Off, WifiOff } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AccessGate } from "./AccessGate.tsx";
import { type Ask, api, type Meta, PublicError } from "./api.ts";
import { Thread } from "./Thread.tsx";

type State =
  | { kind: "loading" }
  | { kind: "gate"; mode: string }
  | { kind: "inactive" }
  | { kind: "offline" }
  | { kind: "ready"; meta: Meta };

const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString() : "");

function LanguageSwitch() {
  const { t, locale, setLocale } = useI18n();
  return (
    <label className="inline-flex items-center gap-1 text-xs text-faint">
      <span className="sr-only">{t.common.language}</span>
      <select
        className="cursor-pointer rounded-control bg-transparent px-1 py-0.5 hover:text-muted"
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {t.common.languages[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AskPage() {
  const { t: all } = useI18n();
  const t = all.ask;
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

  if (state.kind === "loading") {
    return (
      <div
        role="status"
        aria-label={all.common.loading}
        className="mx-auto max-w-2xl space-y-3 px-4 pt-8"
      >
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-3 w-full" />
      </div>
    );
  }
  if (state.kind === "gate") return <AccessGate mode={state.mode} onGranted={load} />;
  if (state.kind === "inactive" || state.kind === "offline") {
    const Icon = state.kind === "inactive" ? Link2Off : WifiOff;
    return (
      <main className="mx-auto mt-24 max-w-sm px-4 text-center">
        <span className="mb-3 inline-flex size-10 items-center justify-center rounded-full bg-subtle text-muted">
          <Icon aria-hidden className="size-5" />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">
          {state.kind === "inactive" ? t.inactive : t.offline(t.theOwner)}
        </h1>
        {state.kind === "inactive" && <p className="mt-2 text-sm text-muted">{t.inactiveHint}</p>}
        {state.kind === "offline" && (
          <Button className="mt-4" onClick={() => void load()}>
            {all.common.retry}
          </Button>
        )}
      </main>
    );
  }

  const { meta } = state;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4">
      <header className="border-b border-line pb-5 pt-6">
        <p className="text-ui text-muted">{t.asking(meta.owner)}</p>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight sm:text-2xl">{meta.title}</h1>
        <p className="mt-2 text-ui leading-5 text-muted">{t.automated(meta.owner)}</p>
        {meta.coverage.length > 0 && (
          <details className="group mt-3 text-ui">
            <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 text-muted hover:text-fg">
              <ChevronDown
                aria-hidden
                className="size-4 transition-transform duration-150 group-open:rotate-180"
              />
              {t.covers}
            </summary>
            <ul className="mt-2 space-y-1 border-l border-line pl-3">
              {meta.coverage.map((c) => (
                <li key={`${c.project}/${c.bundle}`}>
                  <span className="font-medium">{c.bundle}</span>
                  <span className="text-muted">
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
            <h2 className="mb-2 text-ui font-medium text-muted">{t.suggested}</h2>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {meta.suggested_questions.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void ask(q)}
                  className="rounded-card border border-line bg-surface px-3.5 py-2.5 text-left text-sm transition-colors duration-150 hover:border-accent hover:bg-accent-soft"
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

      <footer className="sticky bottom-0 bg-bg pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        {error && <ErrorBanner className="mb-2" title={error} />}
        <form
          onSubmit={submit}
          className="flex items-end gap-2 rounded-card border border-line bg-surface p-1.5 transition-colors focus-within:border-ring"
        >
          <Textarea
            className="max-h-40 min-h-10 flex-1 resize-none border-0 bg-transparent text-base hover:border-0 focus-visible:outline-none sm:text-sm"
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
          <Button
            type="submit"
            variant="primary"
            size="icon"
            className="size-10"
            aria-label={t.ask}
            loading={busy}
            disabled={!question.trim()}
          >
            {!busy && <ArrowUp aria-hidden />}
          </Button>
        </form>
        <div className="mt-3 flex items-center justify-center gap-3">
          {meta.footer && (
            <a
              href="https://github.com/TrH203/pama"
              className="text-xs text-faint hover:text-muted hover:underline"
              rel="noopener"
            >
              {t.footer}
            </a>
          )}
          <LanguageSwitch />
        </div>
      </footer>
    </div>
  );
}
