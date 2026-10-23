// Hotkey popup (US3): the captured question, a cited draft, and Copy / Paste / Shorter / Edit /
// Change scope / Create Ask Link. It never sends anything: Paste only fills the focused field.
import { useCallback, useEffect, useState } from "react";
import { type Draft, draftApi, type SourceRef } from "./api.ts";
import { type CaptureResult, ipc, onHotkey } from "./ipc.ts";

const REFUSED: Record<string, string> = {
  out_of_scope: "Your approved notes don't cover this.",
  low_confidence: "Not confident enough to draft from your notes.",
  denied_topic: "This topic is excluded.",
  guard_failed: "The draft was blocked by the safety check.",
};

export function Popup() {
  const [question, setQuestion] = useState("");
  const [method, setMethod] = useState<CaptureResult["method"]>("none");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState<SourceRef[] | undefined>();
  const [bundles, setBundles] = useState<{ id: string; name: string; project: string }[] | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [axDenied, setAxDenied] = useState(false);

  const run = useCallback(
    async (q: string, opts: { scope_hint?: SourceRef[]; shorter?: boolean } = {}) => {
      if (!q.trim()) return;
      setBusy(true);
      setError(null);
      try {
        const d = await draftApi.draft(q, opts);
        setDraft(d);
        setText(d.answer ?? "");
        setEditing(false);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const start = useCallback(
    (c: CaptureResult) => {
      setQuestion(c.text ?? "");
      setMethod(c.method);
      setDraft(null);
      setText("");
      setScope(undefined);
      if (c.text) void run(c.text);
    },
    [run],
  );

  useEffect(() => {
    void ipc
      .captureSelection()
      .then(start)
      .catch(() => undefined);
    void ipc
      .getPermissions()
      .then((p) => setAxDenied(p.accessibility === "denied"))
      .catch(() => undefined);
    const off = onHotkey((e) => start(e.captured));
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") void ipc.hidePopup();
    };
    window.addEventListener("keydown", esc);
    return () => {
      void off.then((f) => f());
      window.removeEventListener("keydown", esc);
    };
  }, [start]);

  const answered = draft?.status === "answered";
  return (
    <div className="flex h-screen flex-col gap-3 bg-white p-4 text-sm">
      {axDenied && (
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">
          Allow pamA in Accessibility to read selected text without the clipboard.{" "}
          <button type="button" className="underline" onClick={() => ipc.openPermissionSettings()}>
            Open settings
          </button>
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(question, { scope_hint: scope });
        }}
      >
        <label className="mb-1 block text-xs text-stone-500" htmlFor="q">
          Question{" "}
          {method !== "none" && method !== "clipboard" ? `(read via ${method.toUpperCase()})` : ""}
        </label>
        <textarea
          id="q"
          className="w-full resize-none rounded border border-stone-300 p-2"
          rows={2}
          placeholder="Paste or type the question…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void run(question, { scope_hint: scope });
            }
          }}
        />
      </form>

      <section className="min-h-0 flex-1 overflow-auto">
        {busy && <p className="animate-pulse text-stone-500">Drafting…</p>}
        {error && <p className="text-red-700">{error}</p>}
        {!busy && draft && !answered && (
          <p className="rounded bg-amber-50 p-2 text-amber-900">
            {REFUSED[draft.reason ?? ""] ?? REFUSED.out_of_scope}
          </p>
        )}
        {!busy &&
          answered &&
          (editing ? (
            <textarea
              className="h-full min-h-32 w-full rounded border border-stone-300 p-2"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Draft"
            />
          ) : (
            <p className="whitespace-pre-wrap leading-relaxed">{text}</p>
          ))}
        {!busy && answered && draft?.citations.length ? (
          <p className="mt-2 flex flex-wrap gap-1 text-xs text-stone-500">
            {draft.citations.map((c, i) => (
              <span key={c.item_id} className="rounded bg-stone-100 px-1.5 py-0.5">
                [{i + 1}] {c.label}
              </span>
            ))}
          </p>
        ) : null}
      </section>

      {bundles && (
        <select
          className="rounded border border-stone-300 p-1.5"
          aria-label="Scope"
          value={scope?.[0]?.id ?? ""}
          onChange={(e) => {
            const s = e.target.value
              ? [{ type: "bundle" as const, id: e.target.value }]
              : undefined;
            setScope(s);
            void run(question, { scope_hint: s });
          }}
        >
          <option value="">All my approved work</option>
          {bundles.map((b) => (
            <option key={b.id} value={b.id}>
              {b.project} / {b.name}
            </option>
          ))}
        </select>
      )}

      <footer className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!answered || busy}
          onClick={() => ipc.pasteDraft(text)}
        >
          Paste
        </button>
        <button
          type="button"
          className="btn"
          disabled={!answered || busy}
          onClick={async () => {
            await ipc.copyDraft(text);
            await ipc.hidePopup();
          }}
        >
          Copy
        </button>
        <button
          type="button"
          className="btn"
          disabled={!answered || busy}
          onClick={() => run(question, { scope_hint: scope, shorter: true })}
        >
          Shorter
        </button>
        <button
          type="button"
          className="btn"
          disabled={!answered}
          onClick={() => setEditing((x) => !x)}
        >
          {editing ? "Done" : "Edit"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => setBundles(bundles ? null : (await draftApi.bundles()).items)}
        >
          Scope
        </button>
        <button
          type="button"
          className="btn"
          disabled={!question.trim()}
          onClick={() => ipc.openConsole(`/?tab=links&q=${encodeURIComponent(question)}`)}
        >
          Create Ask Link
        </button>
      </footer>
    </div>
  );
}
