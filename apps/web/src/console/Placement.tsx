// Settings → Where things run: every component, where it runs now and where else it can.
// Read-only: placement follows from the server mode and the model settings, so the page links
// to the place where each one is changed instead of duplicating the controls.
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";

type Place = "device" | "server" | "cloud";
interface Component {
  id: string;
  name: string;
  what: string;
  movable: boolean;
  current: Place;
  detail: string;
  options: { place: Place; how: string }[];
}
interface Topology {
  mode: "local" | "selfhost" | "cloud";
  baseUrl: string;
  db: string;
  strictOffline: boolean;
  declaredHosts: string[];
  components: Component[];
  dataFlow: string[];
}

const PLACE: Record<Place, { label: string; tone: string }> = {
  device: { label: "Your machine", tone: "bg-stone-900 text-white" },
  server: { label: "This server", tone: "bg-sky-100 text-sky-900" },
  cloud: { label: "Cloud", tone: "bg-amber-100 text-amber-900" },
};
const MODE: Record<Topology["mode"], string> = {
  local: "Local: everything on this machine",
  selfhost: "Self-hosted: your own server",
  cloud: "pamA Cloud: a hosted server",
};

function Pill({ place }: { place: Place }) {
  const p = PLACE[place];
  return <span className={`rounded px-2 py-0.5 text-xs ${p.tone}`}>{p.label}</span>;
}

export function Placement() {
  const [t, setT] = useState<Topology | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Topology>("/v1/settings/topology")
      .then(setT)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  if (err) return <p className="text-red-700">{err}</p>;
  if (!t) return <p className="text-stone-500">Loading…</p>;
  return (
    <section className="space-y-4">
      <div className="rounded border border-stone-200 p-4">
        <p className="font-semibold">{MODE[t.mode]}</p>
        <p className="text-sm text-stone-500">
          {t.baseUrl} · database: {t.db}
        </p>
      </div>

      <ul className="space-y-3">
        {t.components.map((c) => (
          <li key={c.id} className="space-y-2 rounded border border-stone-200 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{c.name}</h3>
              <Pill place={c.current} />
              {!c.movable && (
                <span className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-700">
                  fixed
                </span>
              )}
            </div>
            <p className="text-sm text-stone-500">{c.what}</p>
            <p className="text-sm">{c.detail}</p>
            <details className="text-sm text-stone-600">
              <summary className="cursor-pointer">
                {c.movable ? "Other places it can run" : "Why it cannot move"}
              </summary>
              <ul className="mt-1 space-y-1">
                {c.options.map((o) => (
                  <li key={o.place + o.how} className="flex gap-2">
                    <Pill place={o.place} />
                    <span>{o.how}</span>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>

      <div className="rounded border border-stone-200 p-4">
        <h3 className="font-semibold">What leaves your machine</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {t.dataFlow.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-stone-600">
          Strict offline: {t.strictOffline ? "on" : "off"}
          {t.declaredHosts.length > 0 && ` · declared hosts: ${t.declaredHosts.join(", ")}`}. Change
          it in the desktop app (Settings → Strict offline mode).
        </p>
      </div>
    </section>
  );
}
