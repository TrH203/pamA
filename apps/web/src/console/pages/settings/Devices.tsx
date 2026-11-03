// Settings → Devices (spec 005 §3.4): machines connected to this server, revoke, and a pairing
// code shown with the exact `pama connect` command to run on the new machine.
import { useI18n } from "@pama/i18n";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useConfirm,
  useToast,
} from "@pama/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Laptop, MonitorSmartphone } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../../../lib/api.ts";
import {
  type Device,
  type PairingCode,
  settingsKeys,
  type Topology,
  useDevices,
  useTopology,
} from "./data.ts";
import { CopyCommand, clock, Loaded, relative } from "./shared.tsx";

function PairingResult({ code, baseUrl }: { code: PairingCode; baseUrl: string }) {
  const { t, locale } = useI18n();
  const d = t.pages.settings.devices;
  return (
    <Card aria-labelledby="pair-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 id="pair-title" className="text-sm font-semibold">
          {d.codeTitle}
        </h2>
        <output className="font-mono text-lg font-semibold tracking-widest">{code.code}</output>
        <span className="text-ui text-muted">{d.codeExpires(clock(code.expires_at, locale))}</span>
      </div>
      <CopyCommand hint={d.codeCommand} command={`pama connect ${baseUrl} --code ${code.code}`} />
    </Card>
  );
}

function DeviceTable({ items }: { items: Device[] }) {
  const { t, locale } = useI18n();
  const d = t.pages.settings.devices;
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/devices/${id}/revoke`, { method: "POST", json: {} }),
    onSuccess: () => {
      toast.success(d.revokedToast);
      void qc.invalidateQueries({ queryKey: settingsKeys.devices });
    },
    onError: (e) => toast.error(d.revokeFailed, errorMessage(e)),
  });
  return (
    <Table label={d.title}>
      <THead>
        <tr>
          <TH>{d.name}</TH>
          <TH>{d.lastSeen}</TH>
          <TH className="hidden sm:table-cell">{d.added}</TH>
          <TH>{d.status}</TH>
          <TH>
            <span className="sr-only">{d.revoke}</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {items.map((x) => (
          <TR key={x.id}>
            <TD className="font-medium">{x.name}</TD>
            <TD className="whitespace-nowrap text-muted">
              {x.last_seen_at ? relative(x.last_seen_at, locale) : d.never}
            </TD>
            <TD className="hidden whitespace-nowrap text-muted sm:table-cell">
              {new Date(x.created_at).toLocaleDateString(locale)}
            </TD>
            <TD>
              {x.revoked_at ? (
                <StatusPill tone="neutral">{d.revoked}</StatusPill>
              ) : (
                <StatusPill tone="success">{d.active}</StatusPill>
              )}
            </TD>
            <TD className="text-right">
              {!x.revoked_at && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${d.revoke} ${x.name}`}
                  disabled={revoke.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: d.revokeTitle(x.name),
                      description: d.revokeBody,
                      confirmLabel: d.revoke,
                      danger: true,
                    });
                    if (ok) revoke.mutate(x.id);
                  }}
                >
                  {d.revoke}
                </Button>
              )}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function ServerDevices({ topo }: { topo: Topology }) {
  const { t } = useI18n();
  const d = t.pages.settings.devices;
  const toast = useToast();
  const devices = useDevices();
  const [code, setCode] = useState<PairingCode | null>(null);
  const pair = useMutation({
    mutationFn: () => api<PairingCode>("/v1/devices/pairing-code", { method: "POST", json: {} }),
    onSuccess: setCode,
    onError: (e) => toast.error(d.pairFailed, errorMessage(e)),
  });
  const pairButton = (
    <Button variant="primary" loading={pair.isPending} onClick={() => pair.mutate()}>
      <KeyRound aria-hidden />
      {d.pair}
    </Button>
  );
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={d.title} description={d.description} actions={pairButton} />
      </Card>
      {code && <PairingResult code={code} baseUrl={topo.baseUrl} />}
      <Loaded queries={[devices]}>
        {() => {
          const items = devices.data?.items ?? [];
          return items.length === 0 ? (
            <EmptyState icon={MonitorSmartphone} title={d.empty} description={d.emptyHint} />
          ) : (
            <DeviceTable items={items} />
          );
        }}
      </Loaded>
    </div>
  );
}

export function Devices() {
  const { t } = useI18n();
  const d = t.pages.settings.devices;
  const topo = useTopology();
  return (
    <Loaded queries={[topo]} rows={2}>
      {() => {
        const tp = topo.data as Topology;
        if (tp.mode !== "local") return <ServerDevices topo={tp} />;
        return (
          <EmptyState
            icon={Laptop}
            title={d.localTitle}
            description={d.localHint}
            action={<CopyCommand command="pama connect <url> --code <code>" />}
          />
        );
      }}
    </Loaded>
  );
}
