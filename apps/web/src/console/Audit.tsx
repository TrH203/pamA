// Every question asked through links or the hotkey, with outcome, citations and guard results.
import { useI18n } from "@pama/i18n";
import {
  Button,
  EmptyState,
  ErrorBanner,
  Select,
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
import { useQuery } from "@tanstack/react-query";
import { Download, ScrollText, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { api, errorMessage, token } from "../lib/api.ts";

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

const STATUSES = ["answered", "refused", "forwarded", "owner_answered", "dismissed", "drafted"];
const TONE: Record<string, Tone> = {
  answered: "success",
  owner_answered: "success",
  drafted: "accent",
  refused: "warning",
  forwarded: "warning",
  dismissed: "neutral",
};

export function Audit() {
  const { t } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState("");
  const rows = useQuery({
    queryKey: ["audit", status],
    queryFn: () => api<{ items: Row[] }>(`/v1/audit${status ? `?status=${status}` : ""}`),
  });

  async function exportCsv() {
    try {
      const t0 = token();
      const res = await fetch(`/v1/audit?format=csv${status ? `&status=${status}` : ""}`, {
        headers: t0 ? { authorization: `Bearer ${t0}` } : {},
      });
      if (!res.ok) throw new Error(res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), {
        href: url,
        download: "pama-audit.csv",
      });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error("Couldn't export", errorMessage(e));
    }
  }

  return (
    <section className="space-y-4" aria-label={t.pages.audit.title}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-ui text-muted">{t.pages.audit.description}</p>
        <Select
          className="w-44"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status"
        >
          <option value="">All outcomes</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace("_", " ")}
            </option>
          ))}
        </Select>
        <Button onClick={exportCsv}>
          <Download aria-hidden />
          Export CSV
        </Button>
      </div>
      {rows.isPending && <SkeletonList rows={2} label={t.common.loading} />}
      {rows.isError && (
        <ErrorBanner
          title={t.common.loadFailed}
          message={errorMessage(rows.error)}
          onRetry={() => void rows.refetch()}
          retryLabel={t.common.retry}
        />
      )}
      {rows.data?.items.length === 0 && (
        <EmptyState
          icon={ScrollText}
          title={t.pages.audit.empty}
          description={t.pages.audit.emptyHint}
        />
      )}
      {!!rows.data?.items.length && (
        <Table label={t.pages.audit.title}>
          <THead>
            <tr>
              <TH>When</TH>
              <TH>Question</TH>
              <TH>Outcome</TH>
              <TH className="text-right">Cited</TH>
              <TH>Asker</TH>
            </tr>
          </THead>
          <TBody>
            {rows.data.items.map((r) => (
              <TR key={r.id}>
                <TD className="whitespace-nowrap text-xs text-muted">
                  {new Date(r.created_at).toLocaleString()}
                </TD>
                <TD className="min-w-64">
                  <p>{r.question}</p>
                  {r.answer && <p className="mt-1 line-clamp-3 text-muted">{r.answer}</p>}
                </TD>
                <TD>
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusPill tone={TONE[r.status] ?? "neutral"}>
                      {r.status.replace("_", " ")}
                    </StatusPill>
                    {r.useful !== null &&
                      (r.useful ? (
                        <ThumbsUp aria-label="Marked useful" className="size-3.5 text-success" />
                      ) : (
                        <ThumbsDown
                          aria-label="Marked not useful"
                          className="size-3.5 text-danger"
                        />
                      ))}
                  </div>
                  {r.reason && (
                    <p className="mt-1 text-xs text-muted">{r.reason.replaceAll("_", " ")}</p>
                  )}
                </TD>
                <TD className="text-right tabular-nums">{r.citations.length}</TD>
                <TD className="text-xs text-muted">
                  {r.asker_email ?? (r.origin === "hotkey" ? "you (hotkey)" : "anonymous")}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}
