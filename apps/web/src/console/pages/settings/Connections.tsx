// Settings → Connections (spec 005 §3.4): where the data lives and the model of each role with
// its origin, last check and the Check / Change actions. A cloud workspace owner changes only the
// chat model; the other roles say who sets them instead of offering a button that would fail.
import { useI18n } from "@pama/i18n";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogContent,
  Notice,
  StatusPill,
  useToast,
} from "@pama/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Cloud, Database, HardDrive, Laptop, Server, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../../../lib/api.ts";
import {
  type Check,
  type EffectiveRole,
  isTenant,
  type ModelSettings,
  ROLES,
  type Role,
  settingsKeys,
  type Topology,
  useEffective,
  useModelSettings,
  useTopology,
} from "./data.ts";
import { CheckList, RoleEditor } from "./RoleEditor.tsx";
import { providerLabel } from "./registry.ts";
import { CopyCommand, Loaded } from "./shared.tsx";

const HINT: Record<
  Topology["mode"],
  (h: { localHint: string; selfhostHint: string; cloudHint: string }) => string
> = {
  local: (h) => h.localHint,
  selfhost: (h) => h.selfhostHint,
  cloud: (h) => h.cloudHint,
};

function DataHome({ topo }: { topo: Topology }) {
  const { t } = useI18n();
  const h = t.pages.settings.home;
  const Icon = topo.mode === "local" ? Laptop : topo.mode === "cloud" ? Cloud : Server;
  return (
    <Card aria-labelledby="home-title">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 id="home-title" className="text-xs font-medium text-muted">
            {h.title}
          </h2>
          <p className="text-sm font-semibold">{h[topo.mode]}</p>
          <p className="text-ui text-muted">{HINT[topo.mode](h)}</p>
        </div>
        <StatusPill tone="success">{h.running}</StatusPill>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-ui sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">{h.address}</dt>
        <dd className="min-w-0 break-all font-mono text-xs">{topo.baseUrl}</dd>
        <dt className="text-muted">{h.database}</dt>
        <dd className="flex items-center gap-1.5 font-mono text-xs">
          <Database aria-hidden className="size-3.5 text-muted" />
          {topo.db}
        </dd>
      </dl>
      <div className="mt-4 space-y-2 border-t border-line pt-4">
        <p className="text-ui text-muted">{h.switchHint}</p>
        <CopyCommand command="pama use local" />
        <CopyCommand command={`pama connect ${topo.mode === "local" ? "<url>" : topo.baseUrl}`} />
      </div>
    </Card>
  );
}

function LastCheck({ check }: { check: Check | undefined }) {
  const { t } = useI18n();
  const m = t.pages.settings.models;
  if (!check) return <StatusPill tone="neutral">{m.neverChecked}</StatusPill>;
  return check.ok ? (
    <StatusPill tone="success">{m.checkOk(check.latencyMs)}</StatusPill>
  ) : (
    <StatusPill tone="danger">{m.checkFailed}</StatusPill>
  );
}

function RoleRow({
  role,
  v,
  settings,
  tenant,
  onChanged,
}: {
  role: Role;
  v: EffectiveRole;
  settings: ModelSettings;
  tenant: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const m = t.pages.settings.models;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Check | undefined>(settings.roles[role]?.lastCheck);
  const editable = !tenant || role === "chat";
  const title = m.roles[role].title;

  async function runCheck() {
    setChecking(true);
    try {
      const r = await api<Check>("/v1/models/check", { json: { role } });
      setCheck(r);
      onChanged();
    } catch (err) {
      toast.error(t.pages.settings.editor.testFailed, errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            <span className="text-ui text-muted">{m.roles[role].hint}</span>
          </div>
          <p className="text-ui">
            <span className="font-medium">{providerLabel(v.preset)}</span>
            <span className="text-muted"> · </span>
            <span className="break-all font-mono text-xs">{v.model}</span>
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              tone={v.origin === "saved" ? "accent" : "neutral"}
              title={m.originHint[v.origin]}
            >
              {m.origin[v.origin]}
            </Badge>
            {v.scope === "workspace" && <Badge tone="accent">{m.yours}</Badge>}
            <StatusPill tone="neutral" icon={v.local ? HardDrive : Cloud}>
              {v.local ? m.local : m.cloud}
            </StatusPill>
            {editable && <LastCheck check={check} />}
          </div>
        </div>
        {editable ? (
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              loading={checking}
              onClick={runCheck}
              aria-label={`${m.check}: ${title}`}
            >
              {checking ? m.checking : m.check}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => setOpen(true)}
              aria-label={`${m.change}: ${title}`}
            >
              {m.change}
            </Button>
          </div>
        ) : (
          <p className="text-ui text-muted">{m.operatorOnly}</p>
        )}
      </div>
      {check && !check.ok && editable && <CheckList check={check} />}
      {editable && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            title={t.pages.settings.editor.title(title)}
            description={t.pages.settings.editor.description}
            closeLabel={t.common.close}
            className="max-w-lg"
          >
            <RoleEditor
              role={role}
              current={v}
              settings={settings.roles[role]}
              strict={settings.strict_offline}
              tenant={tenant}
              onDone={() => {
                setOpen(false);
                onChanged();
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </li>
  );
}

export function Connections() {
  const { t } = useI18n();
  const m = t.pages.settings.models;
  const qc = useQueryClient();
  const topo = useTopology();
  const eff = useEffective();
  const set = useModelSettings();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: settingsKeys.models });
    void qc.invalidateQueries({ queryKey: settingsKeys.topology });
  };
  return (
    <Loaded queries={[topo, eff, set]}>
      {() => {
        const e = eff.data as NonNullable<typeof eff.data>;
        const s = set.data as ModelSettings;
        const tenant = isTenant(s);
        return (
          <div className="space-y-4">
            <DataHome topo={topo.data as Topology} />
            <Card>
              <CardHeader title={m.title} description={m.description} />
              {e.strict_offline && (
                <Notice tone="warning" icon={ShieldAlert} className="mb-3">
                  {m.strictOffline}
                </Notice>
              )}
              <ul className="divide-y divide-line">
                {ROLES.map((r) => (
                  <RoleRow
                    key={r}
                    role={r}
                    v={e.roles[r]}
                    settings={s}
                    tenant={tenant}
                    onChanged={refresh}
                  />
                ))}
              </ul>
            </Card>
          </div>
        );
      }}
    </Loaded>
  );
}
