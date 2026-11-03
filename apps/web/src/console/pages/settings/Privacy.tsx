// Settings → Privacy: strict offline mode, declared hosts, what leaves and where each part runs.
// Read-only on the web: the desktop app and the CLI own these switches (they guard the device).
import { useI18n } from "@pama/i18n";
import { Badge, Card, CardHeader, StatusPill, type Tone } from "@pama/ui";
import { Cloud, Laptop, Lock, type LucideIcon, Server, ShieldCheck } from "lucide-react";
import { type Place, type Topology, useTopology } from "./data.ts";
import { CopyCommand, Loaded } from "./shared.tsx";

const PLACE: Record<Place, { tone: Tone; icon: LucideIcon }> = {
  device: { tone: "accent", icon: Laptop },
  server: { tone: "neutral", icon: Server },
  cloud: { tone: "warning", icon: Cloud },
};

function PlaceBadge({ place }: { place: Place }) {
  const { t } = useI18n();
  const { tone, icon: Icon } = PLACE[place];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden />
      {t.pages.settings.privacy.place[place]}
    </Badge>
  );
}

function PrivacyBody({ topo }: { topo: Topology }) {
  const { t } = useI18n();
  const p = t.pages.settings.privacy;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={p.strictTitle}
          description={topo.strictOffline ? p.strictOnHint : p.strictOffHint}
          actions={
            topo.strictOffline ? (
              <StatusPill tone="success" icon={ShieldCheck}>
                {p.strictOn}
              </StatusPill>
            ) : (
              <StatusPill tone="neutral">{p.strictOff}</StatusPill>
            )
          }
        />
        <h3 className="mb-1.5 text-xs font-medium text-muted">{p.hosts}</h3>
        {topo.declaredHosts.length === 0 ? (
          <p className="text-ui text-muted">{p.noHosts}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {topo.declaredHosts.map((h) => (
              <li key={h}>
                <Badge className="font-mono">{h}</Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          <p className="text-ui text-muted">{p.readOnly}</p>
          <CopyCommand command={`pama config set strict_offline ${!topo.strictOffline}`} />
          <CopyCommand command="pama config set declared_hosts <host,...>" />
        </div>
      </Card>
      <Card>
        <CardHeader title={p.flow} />
        <ul className="list-disc space-y-1 pl-5 text-ui">
          {topo.dataFlow.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardHeader title={p.parts} />
        <ul className="divide-y divide-line">
          {topo.components.map((c) => (
            <li key={c.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-ui font-semibold">{c.name}</h4>
                <PlaceBadge place={c.current} />
                {!c.movable && (
                  <Badge>
                    <Lock aria-hidden />
                    {p.fixed}
                  </Badge>
                )}
              </div>
              <p className="text-ui text-muted">{c.what}</p>
              <p className="text-ui">{c.detail}</p>
              {c.options.length > 0 && (
                <details className="text-ui text-muted">
                  <summary className="cursor-pointer select-none rounded-control hover:text-fg">
                    {c.movable ? p.otherPlaces : p.whyFixed}
                  </summary>
                  <ul className="mt-2 space-y-1.5">
                    {c.options.map((o) => (
                      <li key={o.place + o.how} className="flex flex-wrap items-center gap-2">
                        <PlaceBadge place={o.place} />
                        <span>{o.how}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function Privacy() {
  const topo = useTopology();
  return <Loaded queries={[topo]}>{() => <PrivacyBody topo={topo.data as Topology} />}</Loaded>;
}
