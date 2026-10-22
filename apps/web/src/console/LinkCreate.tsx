// Create an Ask Link in under a minute (SC-004): type the question or keywords, keep the
// suggested sources (sensitive ones start unchecked), adjust settings, share.
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";

interface Suggestion {
  ref: { type: "bundle"; id: string };
  title: string;
  project: string;
  score: number;
  sessions: number;
  date_range: { from: string | null; to: string | null };
  flagged_labels: string[];
  preselected: boolean;
}

interface Created {
  slug: string;
  url: string;
  pin?: string;
  suggested_questions: string[];
}

const LABELS = ["business_sensitive", "infra", "customer"] as const;

export function LinkCreate({
  initialQuery = "",
  onCreated,
}: {
  initialQuery?: string;
  onCreated?: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [sources, setSources] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expires, setExpires] = useState("7d");
  const [detail, setDetail] = useState("summary");
  const [access, setAccess] = useState("pin");
  const [pin, setPin] = useState("");
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState<Set<string>>(new Set());
  const [topics, setTopics] = useState("");
  const [instruction, setInstruction] = useState("");
  const [rate, setRate] = useState(30);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function suggest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ sources: Suggestion[] }>("/v1/suggest", { json: { query } });
      setSources(r.sources);
      setPicked(new Set(r.sources.filter((s) => s.preselected).map((s) => s.ref.id)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        sources: (sources ?? []).filter((s) => picked.has(s.ref.id)).map((s) => s.ref),
        expires,
        detail,
        access_mode: access,
        ...(access === "pin" && pin ? { pin } : {}),
        ...(access === "allowlist" ? { allowlist: allow.split(/[\s,]+/).filter(Boolean) } : {}),
        deny_labels: [...deny],
        deny_topics: topics
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        ...(instruction.trim() ? { instruction } : {}),
        rate_limit_per_hour: rate,
      };
      setCreated(await api<Created>("/v1/links", { json: body }));
      onCreated?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const share = created.pin ? `${created.url}\nPIN: ${created.pin}` : created.url;
    return (
      <section className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <h2 className="font-semibold">Link ready</h2>
        <pre className="whitespace-pre-wrap rounded bg-white p-3 text-sm">{share}</pre>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary"
            onClick={() => navigator.clipboard.writeText(share)}
          >
            Copy
          </button>
          <a className="btn" href={created.url} target="_blank" rel="noreferrer">
            Open
          </a>
          <button type="button" className="btn" onClick={() => setCreated(null)}>
            New link
          </button>
        </div>
        {created.suggested_questions.length > 0 && (
          <div className="text-sm">
            <p className="font-medium">Suggested questions shown to askers</p>
            <ul className="list-disc pl-5">
              {created.suggested_questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <form onSubmit={suggest} className="flex gap-2">
        <input
          className="flex-1 rounded border border-stone-300 px-3 py-2"
          placeholder="What will people ask about? e.g. refund shipping fee"
          aria-label="Question or keywords"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={!query.trim()}>
          Suggest sources
        </button>
      </form>

      {sources && (
        <fieldset className="rounded-lg border border-stone-200 bg-white p-4">
          <legend className="px-1 text-sm font-medium">Sources ({picked.size} selected)</legend>
          {sources.length === 0 && (
            <p className="text-sm text-stone-500">No approved digests yet.</p>
          )}
          <ul className="space-y-1">
            {sources.map((s) => (
              <li key={s.ref.id} className="flex items-center gap-2 text-sm">
                <input
                  id={`src-${s.ref.id}`}
                  type="checkbox"
                  checked={picked.has(s.ref.id)}
                  onChange={() =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (n.has(s.ref.id)) n.delete(s.ref.id);
                      else n.add(s.ref.id);
                      return n;
                    })
                  }
                />
                <label htmlFor={`src-${s.ref.id}`} className="flex-1">
                  <span className="font-medium">{s.title}</span>{" "}
                  <span className="text-stone-500">
                    {s.project} · {s.sessions} session(s)
                  </span>
                  {s.flagged_labels.length > 0 && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                      ⚠ {s.flagged_labels.join(", ")}
                    </span>
                  )}
                </label>
                <span className="text-xs text-stone-400">{Math.round(s.score * 100)}%</span>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      {sources && (
        <div className="grid gap-4 rounded-lg border border-stone-200 bg-white p-4 text-sm sm:grid-cols-2">
          <label className="space-y-1">
            <span className="block font-medium">Expires</span>
            <select
              className="w-full rounded border border-stone-300 px-2 py-1.5"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            >
              {["1d", "7d", "30d", "90d"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block font-medium">Detail</span>
            <select
              className="w-full rounded border border-stone-300 px-2 py-1.5"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
            >
              <option value="headline">Headline</option>
              <option value="summary">Summary</option>
              <option value="technical">Technical</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block font-medium">Access</span>
            <select
              className="w-full rounded border border-stone-300 px-2 py-1.5"
              value={access}
              onChange={(e) => setAccess(e.target.value)}
            >
              <option value="pin">PIN</option>
              <option value="open">Anyone with the link</option>
              <option value="email_otp">Email code</option>
              <option value="allowlist">Email allowlist</option>
            </select>
          </label>
          {access === "pin" && (
            <label className="space-y-1">
              <span className="block font-medium">PIN (empty = generate)</span>
              <input
                className="w-full rounded border border-stone-300 px-2 py-1.5"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              />
            </label>
          )}
          {access === "allowlist" && (
            <label className="space-y-1 sm:col-span-2">
              <span className="block font-medium">Allowed emails or *@domain</span>
              <input
                className="w-full rounded border border-stone-300 px-2 py-1.5"
                value={allow}
                onChange={(e) => setAllow(e.target.value)}
                placeholder="pm@client.com, *@acme.vn"
              />
            </label>
          )}
          <div className="space-y-1">
            <span className="block font-medium">Never share items labelled</span>
            {LABELS.map((l) => (
              <label key={l} className="mr-3 inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={deny.has(l)}
                  onChange={() =>
                    setDeny((d) => {
                      const n = new Set(d);
                      if (n.has(l)) n.delete(l);
                      else n.add(l);
                      return n;
                    })
                  }
                />
                {l.replace("_", " ")}
              </label>
            ))}
          </div>
          <label className="space-y-1">
            <span className="block font-medium">Denied topics (comma separated)</span>
            <input
              className="w-full rounded border border-stone-300 px-2 py-1.5"
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder="pricing, roadmap"
            />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="block font-medium">Instruction for answers (optional)</span>
            <textarea
              className="w-full rounded border border-stone-300 px-2 py-1.5"
              rows={2}
              maxLength={2000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Be brief; the asker is from QA."
            />
          </label>
          <label className="space-y-1">
            <span className="block font-medium">Questions per hour</span>
            <input
              className="w-full rounded border border-stone-300 px-2 py-1.5"
              type="number"
              min={1}
              max={500}
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            />
          </label>
        </div>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {sources && (
        <button
          type="button"
          className="btn-primary"
          disabled={busy || picked.size === 0}
          onClick={create}
        >
          Create link
        </button>
      )}
    </section>
  );
}
