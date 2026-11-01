// Hotkey popup (US3): the captured question, a cited draft, and Copy / Paste / Shorter / Edit /
// Change scope / Create Ask Link. It never sends anything: Paste only fills the focused field.
import { useI18n } from "@pama/i18n";
import { Badge, Button, ErrorBanner, Notice, Select, Spinner, Textarea } from "@pama/ui";
import {
  Check,
  ClipboardPaste,
  Copy,
  Crosshair,
  Link2,
  Pencil,
  Scissors,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Draft, draftApi, type SourceRef } from "./api.ts";
import { type CaptureResult, ipc, onHotkey } from "./ipc.ts";

export function Popup() {
  const { t: all } = useI18n();
  const t = all.desktop;
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
    <div className="flex h-screen flex-col gap-3 bg-surface p-4 text-ui text-fg">
      {axDenied && (
        <Notice tone="warning" icon={ShieldAlert}>
          {t.axHint}{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => ipc.openPermissionSettings()}
          >
            {t.openSettings}
          </button>
        </Notice>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(question, { scope_hint: scope });
        }}
      >
        <label className="mb-1.5 block text-xs font-medium text-muted" htmlFor="q">
          {t.question}{" "}
          {method !== "none" && method !== "clipboard" ? t.readVia(method.toUpperCase()) : ""}
        </label>
        <Textarea
          id="q"
          className="resize-none text-sm"
          rows={2}
          placeholder={t.questionPlaceholder}
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

      <section className="min-h-0 flex-1 overflow-auto" aria-live="polite" aria-busy={busy}>
        {busy && (
          <p className="inline-flex items-center gap-2 text-muted">
            <Spinner size="sm" label={null} />
            {t.drafting}
          </p>
        )}
        {error && <ErrorBanner title={all.common.error} message={error} />}
        {!busy && !draft && !error && <p className="text-faint">{t.emptyHint}</p>}
        {!busy && draft && !answered && (
          <Notice tone="warning" icon={TriangleAlert}>
            {t.refused[draft.reason ?? ""] ?? t.refused.out_of_scope}
          </Notice>
        )}
        {!busy &&
          answered &&
          (editing ? (
            <Textarea
              className="h-full min-h-32 text-sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={t.draft}
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-6">{text}</p>
          ))}
        {!busy && answered && draft?.citations.length ? (
          <p className="mt-3 flex flex-wrap gap-1.5">
            {draft.citations.map((c, i) => (
              <Badge key={c.item_id}>
                [{i + 1}] {c.label}
              </Badge>
            ))}
          </p>
        ) : null}
      </section>

      {bundles && (
        <Select
          aria-label={t.scope}
          value={scope?.[0]?.id ?? ""}
          onChange={(e) => {
            const s = e.target.value
              ? [{ type: "bundle" as const, id: e.target.value }]
              : undefined;
            setScope(s);
            void run(question, { scope_hint: s });
          }}
        >
          <option value="">{t.scopeAll}</option>
          {bundles.map((b) => (
            <option key={b.id} value={b.id}>
              {b.project} / {b.name}
            </option>
          ))}
        </Select>
      )}

      <footer className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Button variant="primary" disabled={!answered || busy} onClick={() => ipc.pasteDraft(text)}>
          <ClipboardPaste aria-hidden />
          {t.paste}
        </Button>
        <Button
          disabled={!answered || busy}
          onClick={async () => {
            await ipc.copyDraft(text);
            await ipc.hidePopup();
          }}
        >
          <Copy aria-hidden />
          {t.copy}
        </Button>
        <Button
          disabled={!answered || busy}
          onClick={() => run(question, { scope_hint: scope, shorter: true })}
        >
          <Scissors aria-hidden />
          {t.shorter}
        </Button>
        <Button disabled={!answered} onClick={() => setEditing((x) => !x)}>
          {editing ? <Check aria-hidden /> : <Pencil aria-hidden />}
          {editing ? t.done : t.edit}
        </Button>
        <Button
          variant="ghost"
          aria-pressed={bundles !== null}
          onClick={async () => setBundles(bundles ? null : (await draftApi.bundles()).items)}
        >
          <Crosshair aria-hidden />
          {t.scope}
        </Button>
        <Button
          variant="ghost"
          disabled={!question.trim()}
          onClick={() => ipc.openConsole(`/links?q=${encodeURIComponent(question)}`)}
        >
          <Link2 aria-hidden />
          {t.createLink}
        </Button>
      </footer>
    </div>
  );
}
