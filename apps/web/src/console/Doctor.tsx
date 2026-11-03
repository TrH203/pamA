// Doctor: the same checks as `pama doctor`, plus scan and capture state. Polls /v1/doctor, which
// runs `pama doctor --report` on this machine.
import { useI18n } from "@pama/i18n";
import {
  Button,
  Card,
  CardHeader,
  ErrorBanner,
  SkeletonList,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  type Tone,
  TR,
  useToast,
} from "@pama/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, RotateCw } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../lib/api.ts";

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

const POLL_MS = 30_000;
const TONE: Record<string, Tone> = {
  failed: "danger",
  submitted: "success",
  ready_for_review: "accent",
  skipped: "neutral",
};

function Pill({ status, n }: { status: string; n?: number }) {
  return (
    <StatusPill tone={TONE[status] ?? "warning"}>
      {status.replaceAll("_", " ")}
      {n !== undefined && ` ${n}`}
    </StatusPill>
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
  const { t } = useI18n();
  const qc = useQueryClient();
  const report = useQuery({
    queryKey: ["doctor"],
    queryFn: () => api<Report>("/v1/doctor"),
    refetchInterval: () => (document.hidden ? false : POLL_MS),
  });
  const toast = useToast();
  const [rerunning, setRerunning] = useState(false);
  // Always hit ?fresh=1 (fetchQuery would return the cached report while it is fresh), and cancel
  // any background poll so a stale response cannot overwrite the new one.
  const rerun = async () => {
    setRerunning(true);
    try {
      await qc.cancelQueries({ queryKey: ["doctor"] });
      qc.setQueryData(["doctor"], await api<Report>("/v1/doctor?fresh=1"));
    } catch (e) {
      toast.error(t.pages.doctor.rerunFailed, errorMessage(e));
    } finally {
      setRerunning(false);
    }
  };
  const r = report.data;

  return (
    <section className="space-y-4" aria-label={t.pages.doctor.title}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-ui text-muted">{t.pages.doctor.description}</p>
        {r && (
          <span className="text-xs text-faint">
            updated {ago(r.at)} · every {POLL_MS / 1000}s
          </span>
        )}
        <Button loading={rerunning} onClick={() => void rerun()}>
          <RotateCw aria-hidden />
          Re-run
        </Button>
      </div>
      {report.isError && (
        <ErrorBanner
          title={t.common.loadFailed}
          message={errorMessage(report.error)}
          onRetry={() => void report.refetch()}
          retryLabel={t.common.retry}
        />
      )}
      {report.isPending && <SkeletonList rows={2} label={t.common.loading} />}
      {r && (
        <>
          <Card className="p-0">
            <ul className="divide-y divide-line">
              {r.checks.map((c) => (
                <li
                  key={c.check}
                  className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-ui"
                >
                  {c.ok ? (
                    <CircleCheck aria-label="OK" className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <CircleAlert
                      aria-label="Failed"
                      className="mt-0.5 size-4 shrink-0 text-danger"
                    />
                  )}
                  <span className="w-36 font-medium">{c.check}</span>
                  <span className="min-w-0 flex-1 text-muted">{c.detail}</span>
                  {c.fix && (
                    <span className="w-full pl-7 text-danger-ink">
                      → <code className="text-xs">{c.fix}</code>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Scan"
              description={
                r.scan
                  ? `Last \`pama scan\` ${ago(r.scan.at)}: ${r.scan.seen} ended sessions found, ${r.scan.enqueued} queued.`
                  : "`pama scan` has not run yet. Hooks capture sessions as they end."
              }
            />
            <div className="flex flex-wrap items-center gap-2 text-ui">
              <span className="text-muted">{r.captures.total} captures</span>
              {Object.entries(r.captures.byStatus).map(([s, n]) => (
                <Pill key={s} status={s} n={n} />
              ))}
              {r.outbox.pending + r.outbox.failed > 0 && (
                <span className="text-muted">
                  · sync outbox {r.outbox.pending} pending, {r.outbox.failed} failed
                </span>
              )}
            </div>
          </Card>

          {r.captures.recent.length > 0 && (
            <Table label="Recent captures">
              <THead>
                <tr>
                  <TH>Ended</TH>
                  <TH>Project</TH>
                  <TH>Agent</TH>
                  <TH>Status</TH>
                  <TH>Error</TH>
                </tr>
              </THead>
              <TBody>
                {r.captures.recent.map((c) => (
                  <TR key={c.id}>
                    <TD className="whitespace-nowrap text-muted">{ago(c.endedAt)}</TD>
                    <TD className="font-mono text-xs">{c.cwd ?? "—"}</TD>
                    <TD>{c.agent.replace("_", " ")}</TD>
                    <TD>
                      <Pill status={c.status} />
                    </TD>
                    <TD className="text-danger-ink">
                      {c.error}
                      {c.error && c.attempts > 1 && ` (${c.attempts} attempts)`}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </>
      )}
    </section>
  );
}
