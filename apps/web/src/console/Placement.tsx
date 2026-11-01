// Settings → Where things run: every component, where it runs now and where else it can.
// Read-only: placement follows from the server mode and the model settings, so the page links
// to the place where each one is changed instead of duplicating the controls.
import { useI18n } from "@pama/i18n";
import { Badge, Button, Card, CardHeader, ErrorBanner, SkeletonList, type Tone } from "@pama/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, Laptop, Lock, Server } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../lib/api.ts";
import { type Role, RoleCard, type Settings } from "./Models.tsx";

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

const PLACE: Record<Place, { label: string; tone: Tone; icon: typeof Laptop }> = {
  device: { label: "Your machine", tone: "accent", icon: Laptop },
  server: { label: "This server", tone: "neutral", icon: Server },
  cloud: { label: "Cloud", tone: "warning", icon: Cloud },
};
const MODE: Record<Topology["mode"], string> = {
  local: "Local: everything on this machine",
  selfhost: "Self-hosted: your own server",
  cloud: "pamA Cloud: a hosted server",
};

const CHOICES = [
  ["ollama", "Local (Ollama)"],
  ["openrouter", "OpenRouter"],
  ["anthropic", "Anthropic"],
  ["openai-compatible", "Other endpoint"],
] as const;

/** Move a model between local and cloud without leaving this page. */
function ModelControl({
  role,
  settings,
  onSaved,
}: {
  role: Role;
  settings: Settings;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<string | undefined>();
  const v = settings.roles[role];
  // On a shared cloud server only the answering model is the workspace's own to change.
  if (v.scope === "server") {
    return <p className="text-ui text-muted">Set by the server operator.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-ui">
        <span className="text-muted">Run it on:</span>
        {CHOICES.map(([k, label]) => (
          <Button
            key={k}
            size="sm"
            aria-pressed={v.provider === k && !preset}
            className="aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-ink"
            onClick={() => {
              setPreset(k);
              setOpen(true);
            }}
          >
            {label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Edit details"}
        </Button>
      </div>
      {open && (
        <RoleCard
          role={role}
          v={v}
          strict={settings.strict_offline}
          preset={preset}
          onSaved={() => {
            setPreset(undefined);
            onSaved();
          }}
        />
      )}
    </div>
  );
}

function Pill({ place }: { place: Place }) {
  const p = PLACE[place];
  const Icon = p.icon;
  return (
    <Badge tone={p.tone}>
      <Icon aria-hidden />
      {p.label}
    </Badge>
  );
}

export function Placement() {
  const { t: tr } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["placement"],
    queryFn: () =>
      Promise.all([api<Topology>("/v1/settings/topology"), api<Settings>("/v1/models/settings")]),
  });
  const load = () => {
    void qc.invalidateQueries({ queryKey: ["placement"] });
    void qc.invalidateQueries({ queryKey: ["models"] });
  };
  if (q.isError)
    return (
      <ErrorBanner
        title={tr.common.loadFailed}
        message={errorMessage(q.error)}
        onRetry={() => void q.refetch()}
        retryLabel={tr.common.retry}
      />
    );
  if (!q.data) return <SkeletonList label={tr.common.loading} />;
  const [t, models] = q.data;
  return (
    <section className="space-y-4">
      <Card>
        <p className="text-sm font-semibold">{MODE[t.mode]}</p>
        <p className="mt-0.5 font-mono text-xs text-muted">
          {t.baseUrl} · database: {t.db}
        </p>
      </Card>

      <ul className="space-y-3">
        {t.components.map((c) => (
          <li key={c.id}>
            <Card className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{c.name}</h3>
                <Pill place={c.current} />
                {!c.movable && (
                  <Badge>
                    <Lock aria-hidden />
                    fixed
                  </Badge>
                )}
              </div>
              <p className="text-ui text-muted">{c.what}</p>
              <p className="text-ui">{c.detail}</p>
              {(c.id === "chat" || c.id === "small" || c.id === "embed") && (
                <ModelControl role={c.id as Role} settings={models} onSaved={load} />
              )}
              <details className="text-ui text-muted">
                <summary className="cursor-pointer select-none hover:text-fg">
                  {c.movable ? "Other places it can run" : "Why it cannot move"}
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {c.options.map((o) => (
                    <li key={o.place + o.how} className="flex flex-wrap items-center gap-2">
                      <Pill place={o.place} />
                      <span>{o.how}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </Card>
          </li>
        ))}
      </ul>

      <Card>
        <CardHeader title="What leaves your machine" />
        <ul className="list-disc space-y-1 pl-5 text-ui">
          {t.dataFlow.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className="mt-3 text-ui text-muted">
          Strict offline: {t.strictOffline ? "on" : "off"}
          {t.declaredHosts.length > 0 && ` · declared hosts: ${t.declaredHosts.join(", ")}`}. Change
          it in the desktop app (Settings → Strict offline mode).
        </p>
      </Card>
    </section>
  );
}
