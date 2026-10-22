// Every question asked through links or the hotkey, with outcome, citations and guard results.
import { useCallback, useEffect, useState } from "react";
import { api, token } from "../lib/api.ts";

interface Row {
  id: string;
  created_at: string;
  origin: string;
  link_slug: string | null;
  question: string;
  status: string;
  reason: string | null;
  answer: string | null;
  citations: { item_id: string }[];
  asker_email: string | null;
  useful: boolean | null;
}

export function Audit() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("");
  const load = useCallback(async () => {
    const q = status ? `?status=${status}` : "";
    setRows((await api<{ items: Row[] }>(`/v1/audit${q}`)).items);
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);

  async function exportCsv() {
    const res = await fetch(`/v1/audit?format=csv${status ? `&status=${status}` : ""}`, {
      headers: { authorization: `Bearer ${token()}` },
    });
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: "pama-audit.csv" });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">Audit log</h2>
        <select
          className="rounded border border-stone-300 px-2 py-1.5 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status"
        >
          <option value="">All</option>
          {["answered", "refused", "forwarded", "owner_answered", "dismissed", "drafted"].map(
            (s) => (
              <option key={s}>{s}</option>
            ),
          )}
        </select>
        <button type="button" className="btn" onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-stone-500">
            <tr>
              <th className="py-2">When</th>
              <th>Question</th>
              <th>Outcome</th>
              <th>Cited</th>
              <th>Asker</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-stone-200 align-top">
                <td className="py-2 pr-2 text-xs text-stone-500">
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td className="pr-2">
                  <p>{r.question}</p>
                  {r.answer && <p className="mt-1 text-stone-500">{r.answer}</p>}
                </td>
                <td className="pr-2">
                  {r.status}
                  {r.reason ? ` (${r.reason.replaceAll("_", " ")})` : ""}
                  {r.useful !== null && <span className="ml-1">{r.useful ? "👍" : "👎"}</span>}
                </td>
                <td className="pr-2">{r.citations.length}</td>
                <td className="text-xs">
                  {r.asker_email ?? (r.origin === "hotkey" ? "you (hotkey)" : "anonymous")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
