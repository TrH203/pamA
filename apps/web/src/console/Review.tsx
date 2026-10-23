// Review queue (US1): read each draft digest, then approve, edit or discard it.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { DigestContent, Draft, Project } from "./types.ts";

const LABEL_STYLE: Record<string, string> = {
  infra: "bg-sky-100 text-sky-900",
  business_sensitive: "bg-amber-100 text-amber-900",
  customer: "bg-rose-100 text-rose-900",
};

function Labels({ labels }: { labels?: string[] }) {
  if (!labels?.length) return null;
  return (
    <span className="ml-2 inline-flex gap-1">
      {labels.map((l) => (
        <span
          key={l}
          className={`rounded px-1.5 py-0.5 text-[11px] ${LABEL_STYLE[l] ?? "bg-stone-100"}`}
        >
          {l.replace("_", " ")}
        </span>
      ))}
    </span>
  );
}

function DigestView({ c }: { c: DigestContent }) {
  return (
    <div className="space-y-3 text-sm">
      <p>
        <span className="font-medium">Goal.</span> {c.goal}
      </p>
      {c.decisions.length > 0 && (
        <ol className="list-decimal space-y-2 pl-5">
          {c.decisions.map((d) => (
            <li key={d.id}>
              <span className="font-medium">{d.what}</span>
              <Labels labels={d.labels} />
              {d.why && <div className="text-stone-600">Why: {d.why}</div>}
              {!!d.alternatives?.length && (
                <div className="text-stone-500">Rejected: {d.alternatives.join("; ")}</div>
              )}
            </li>
          ))}
        </ol>
      )}
      {c.outcome && (
        <p>
          <span className="font-medium">Outcome.</span> {c.outcome}
        </p>
      )}
      {c.open_items.length > 0 && (
        <p>
          <span className="font-medium">Open.</span> {c.open_items.join(" · ")}
        </p>
      )}
      <p className="text-xs text-stone-500">
        {c.modules.length > 0 && <>Modules: {c.modules.join(", ")} · </>}
        Removed before digesting: {c.redactions.secret} secret(s), {c.redactions.pii} personal
        item(s)
      </p>
    </div>
  );
}

function DraftCard({ d, onDone }: { d: Draft; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(d.content, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(path: string, json: unknown = {}) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { json });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function approveEdited() {
    let content: unknown;
    try {
      content = JSON.parse(text);
    } catch {
      setError("The digest is not valid JSON.");
      return;
    }
    void act(`/v1/digests/${d.id}/approve`, { content });
  }

  return (
    <article className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">
          {d.project} <span className="font-normal text-stone-500">/ {d.bundle}</span>
        </h3>
        <span className="text-xs text-stone-500">
          {d.content.source.agent.replace("_", " ")} · {new Date(d.created_at).toLocaleString()}
        </span>
      </header>
      {editing ? (
        <textarea
          className="h-80 w-full rounded border border-stone-300 p-2 font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Digest JSON"
        />
      ) : (
        <DigestView c={d.content} />
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      <footer className="mt-4 flex flex-wrap gap-2">
        {editing ? (
          <>
            <button type="button" disabled={busy} onClick={approveEdited} className="btn-primary">
              Approve edited
            </button>
            <button type="button" onClick={() => setEditing(false)} className="btn">
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => act(`/v1/digests/${d.id}/approve`)}
              className="btn-primary"
            >
              Approve
            </button>
            <button type="button" onClick={() => setEditing(true)} className="btn">
              Edit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => act(`/v1/digests/${d.id}/discard`)}
              className="btn-danger"
            >
              Discard
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

function AutoApprove({ projects, reload }: { projects: Project[]; reload: () => void }) {
  if (!projects.length) return null;
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4">
      <h2 className="mb-2 font-semibold">Auto-approve</h2>
      <p className="mb-3 text-sm text-stone-600">
        Off by default: digests stay private until you approve them.
      </p>
      <ul className="space-y-1 text-sm">
        {projects.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <input
              id={`auto-${p.id}`}
              type="checkbox"
              checked={p.auto_approve === true}
              onChange={async (e) => {
                await api(`/v1/projects/${p.id}`, {
                  method: "PATCH",
                  json: { auto_approve: e.target.checked },
                });
                reload();
              }}
            />
            <label htmlFor={`auto-${p.id}`}>{p.name}</label>
            <span className="text-xs text-stone-400">{p.repo_key}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Review() {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([
        api<{ items: Draft[] }>("/v1/review"),
        api<{ items: Project[] }>("/v1/projects"),
      ]);
      setDrafts(r.items);
      setProjects(p.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Waiting for review</h2>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {drafts === null && !error && <p className="text-sm text-stone-500">Loading…</p>}
        {drafts?.length === 0 && (
          <p className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">
            Nothing to review. New sessions appear here a minute or two after they end.
          </p>
        )}
        {drafts?.map((d) => (
          <DraftCard key={d.id} d={d} onDone={load} />
        ))}
      </section>
      <AutoApprove projects={projects} reload={load} />
    </div>
  );
}
