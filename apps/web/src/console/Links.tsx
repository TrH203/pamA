import { useI18n } from "@pama/i18n";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SkeletonList,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  type Tone,
  TR,
  useConfirm,
  useToast,
} from "@pama/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ExternalLink, Link2, Plus, X } from "lucide-react";
import { api, errorMessage } from "../lib/api.ts";
import { LinkCreate } from "./LinkCreate.tsx";

interface LinkRow {
  slug: string;
  title: string;
  status: "active" | "expired" | "revoked";
  access_mode: string;
  expires_at: string;
  asks: number;
}

const STATUS_TONE: Record<LinkRow["status"], Tone> = {
  active: "success",
  expired: "neutral",
  revoked: "danger",
};
const ACCESS: Record<string, string> = {
  pin: "PIN",
  open: "Anyone with the link",
  email_otp: "Email code",
  allowlist: "Email allowlist",
};

export function Links() {
  const { t } = useI18n();
  const s = t.pages.links;
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  // Opened from the hotkey popup with a question (?q=…), or "New Ask Link" in the palette.
  const search = useSearch({ strict: false }) as { q?: string; new?: boolean };
  const creating = Boolean(search.q || search.new);
  const setCreating = (open: boolean) =>
    void navigate({ to: "/links", search: open ? { new: true } : {}, replace: true });

  const links = useQuery({
    queryKey: ["links"],
    queryFn: () => api<{ items: LinkRow[] }>("/v1/links"),
  });
  const reload = () => void qc.invalidateQueries({ queryKey: ["links"] });
  const revoke = useMutation({
    mutationFn: (slug: string) => api(`/v1/links/${slug}/revoke`, { json: {} }),
    onSuccess: () => {
      toast.success(s.revoked);
      reload();
    },
    onError: (e) => toast.error(t.common.error, errorMessage(e)),
  });

  return (
    <>
      <PageHeader
        title={s.title}
        description={s.description}
        actions={
          <Button
            variant={creating ? "secondary" : "primary"}
            onClick={() => setCreating(!creating)}
            aria-expanded={creating}
          >
            {creating ? <X aria-hidden /> : <Plus aria-hidden />}
            {creating ? t.common.close : t.nav.newLink}
          </Button>
        }
      />
      <div className="space-y-6">
        {creating && (
          <Card>
            <LinkCreate initialQuery={search.q ?? ""} onCreated={reload} />
          </Card>
        )}
        {links.isPending && <SkeletonList rows={2} label={t.common.loading} />}
        {links.isError && (
          <ErrorBanner
            title={t.common.loadFailed}
            message={errorMessage(links.error)}
            onRetry={() => void links.refetch()}
            retryLabel={t.common.retry}
          />
        )}
        {links.data?.items.length === 0 && !creating && (
          <EmptyState
            icon={Link2}
            title={s.empty}
            description={s.emptyHint}
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus aria-hidden />
                {t.nav.newLink}
              </Button>
            }
          />
        )}
        {!!links.data?.items.length && (
          <Table label={s.title}>
            <THead>
              <tr>
                <TH>Title</TH>
                <TH>Status</TH>
                <TH>Access</TH>
                <TH>Expires</TH>
                <TH className="text-right">Questions</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {links.data.items.map((l) => (
                <TR key={l.slug}>
                  <TD className="font-medium">
                    <a
                      className="inline-flex items-center gap-1 text-fg underline-offset-2 hover:underline"
                      href={`/a/${l.slug}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {l.title}
                      <ExternalLink aria-hidden className="size-3.5 text-faint" />
                    </a>
                  </TD>
                  <TD>
                    <StatusPill tone={STATUS_TONE[l.status]}>{l.status}</StatusPill>
                  </TD>
                  <TD className="text-muted">{ACCESS[l.access_mode] ?? l.access_mode}</TD>
                  <TD className="whitespace-nowrap text-muted">
                    {new Date(l.expires_at).toLocaleDateString()}
                  </TD>
                  <TD className="text-right tabular-nums">{l.asks}</TD>
                  <TD className="text-right">
                    {l.status === "active" && (
                      <Button
                        size="sm"
                        variant="danger"
                        loading={revoke.isPending && revoke.variables === l.slug}
                        onClick={async () => {
                          const ok = await confirm({
                            title: s.revokeTitle(l.title),
                            description: s.revokeBody,
                            confirmLabel: s.revoke,
                            danger: true,
                          });
                          if (ok) revoke.mutate(l.slug);
                        }}
                      >
                        {s.revoke}
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </>
  );
}
