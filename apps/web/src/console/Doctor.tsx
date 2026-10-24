// Doctor: the same checks as `pama doctor`, plus scan and capture state. Polls /v1/doctor, which
// runs `pama doctor --report` on this machine.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";

interface DoctorCheck {
  check: string;
  ok: boolean;
  detail: string;
  fix: string | null;
}
interface CaptureRow {
  id: string;
  agent: string;
  cwd: string | null;
  status: string;
  error: string | null;
  attempts: number;
  endedAt: number;
}
interface Report {
  ok: boolean;
  at: number;
  checks: DoctorCheck[];
  captures: { total: number; byStatus: Record<string, number>; recent: CaptureRow[] };
  scan: { at: number; seen: number; enqueued: number } | null;
  outbox: { pending: number; failed: number };
}

const POLL_MS = 5_000;
const TONE: Record<string, string> = {
  failed: "bg-red-100 text-red-800",
  submitted: "bg-green-100 text-green-800",
  ready_for_review: "bg-blue-100 text-blue-800",
  skipped: "bg-stone-200 text-stone-700",
};

function Pill({ status, n }: { status: string; n?: number }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs ${TONE[status] ?? "bg-amber-100 text-amber-800"}`}
    >
      {status.replaceAll("_", " ")}
      {n !== undefined && ` ${n}`}
    </span>
  );
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function Doctor() {
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    api<Report>("/v1/doctor")
      .then((d) => {
        setR(d);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">Doctor</h2>
        {r && (
          <span className="text-sm text-stone-500">
            updated {ago(r.at)} · every {POLL_MS / 1000}s
          </span>
        )}
        <button type="button" className="btn" disabled={busy} onClick={load}>
          {busy ? "Checking…" : "Re-run"}
        </button>
      </div>
      {err && <p className="text-sm text-red-700">{err}</p>}
      {!r && !err && <p className="text-stone-500">Checking…</p>}
      {r && (
        <>
          <ul className="divide-y divide-stone-200 rounded border border-stone-200 bg-white">
            {r.checks.map((c) => (
              <li key={c.check} className="flex flex-wrap gap-x-3 px-3 py-2 text-sm">
                <span className={c.ok ? "text-green-700" : "text-red-700"} aria-hidden>
                  {c.ok ? "✓" : "✗"}
                </span>
                <span className="w-36 font-medium">{c.check}</span>
                <span className="text-stone-700">{c.detail}</span>
                {c.fix && <span className="w-full pl-6 text-red-700">→ {c.fix}</span>}
              </li>
            ))}
          </ul>

          <div className="space-y-2 rounded border border-stone-200 bg-white p-3 text-sm">
            <h3 className="font-semibold">Scan</h3>
            <p className="text-stone-700">
              {r.scan
                ? `Last \`pama scan\` ${ago(r.scan.at)}: ${r.scan.seen} ended sessions found, ${r.scan.enqueued} queued.`
                : "`pama scan` has not run yet. Hooks capture sessions as they end."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-stone-500">{r.captures.total} captures</span>
              {Object.entries(r.captures.byStatus).map(([s, n]) => (
                <Pill key={s} status={s} n={n} />
              ))}
              {r.outbox.pending + r.outbox.failed > 0 && (
                <span className="text-stone-500">
                  · sync outbox {r.outbox.pending} pending, {r.outbox.failed} failed
                </span>
              )}
            </div>
          </div>

          <div className="overflow-x-auto rounded border border-stone-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="text-stone-500">
                <tr>
                  <th className="px-3 py-2 font-normal">Ended</th>
                  <th className="px-3 py-2 font-normal">Project</th>
                  <th className="px-3 py-2 font-normal">Agent</th>
                  <th className="px-3 py-2 font-normal">Status</th>
                  <th className="px-3 py-2 font-normal">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {r.captures.recent.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="whitespace-nowrap px-3 py-2">{ago(c.endedAt)}</td>
                    <td className="px-3 py-2">{c.cwd ?? "—"}</td>
                    <td className="px-3 py-2">{c.agent.replace("_", " ")}</td>
                    <td className="px-3 py-2">
                      <Pill status={c.status} />
                    </td>
                    <td className="px-3 py-2 text-red-700">
                      {c.error}
                      {c.error && c.attempts > 1 && ` (${c.attempts} attempts)`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
