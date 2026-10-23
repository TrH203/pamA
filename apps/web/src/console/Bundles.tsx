// Bundles (US1): sessions of one task grouped by branch; rename, split and merge.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Bundle } from "./types.ts";

export function Bundles() {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBundles((await api<{ items: Bundle[] }>("/v1/bundles")).items);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      setPicked(new Set());
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Bundles</h2>
        <button
          type="button"
          className="btn"
          disabled={picked.size < 2}
          onClick={() => {
            const name = prompt("Name of the merged bundle");
            if (name)
              void run(() => api("/v1/bundles/merge", { json: { bundle_ids: [...picked], name } }));
          }}
        >
          Merge selected ({picked.size})
        </button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {bundles.map((b) => (
        <article key={b.id} className="rounded-lg border border-stone-200 bg-white p-4">
          <header className="flex flex-wrap items-center gap-3">
            <input
              type="checkbox"
              aria-label={`Select ${b.name}`}
              checked={picked.has(b.id)}
              onChange={() => toggle(b.id)}
            />
            <h3 className="font-semibold">{b.name}</h3>
            <span className="text-xs text-stone-500">
              {b.project}
              {b.key && b.key !== b.name ? ` · ${b.key}` : ""}
            </span>
            <button
              type="button"
              className="ml-auto text-sm text-stone-600 underline"
              onClick={() => {
                const name = prompt("New name", b.name);
                if (name)
                  void run(() => api(`/v1/bundles/${b.id}`, { method: "PATCH", json: { name } }));
              }}
            >
              Rename
            </button>
          </header>
          <ul className="mt-2 space-y-1 text-sm">
            {b.sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <span className="text-stone-500">{s.agent.replace("_", " ")}</span>
                <code className="text-xs">{s.agent_session_id.slice(0, 8)}</code>
                <span className="text-xs text-stone-400">
                  {s.ended_at ? new Date(s.ended_at).toLocaleString() : ""}
                </span>
                {b.sessions.length > 1 && (
                  <button
                    type="button"
                    className="ml-auto text-xs text-stone-600 underline"
                    onClick={() => {
                      const new_name = prompt("Move this session to a new bundle named");
                      if (new_name)
                        void run(() =>
                          api(`/v1/bundles/${b.id}/split`, {
                            json: { session_ids: [s.id], new_name },
                          }),
                        );
                    }}
                  >
                    Split out
                  </button>
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
