// Desktop settings (US4): sync per source (off by default), strict offline mode with declared
// hosts and the network log, model providers, hotkey and answer source. Restyled with the kit
// (spec 009); behaviour is unchanged.

import { LOCALES, type Locale, useI18n } from "@pama/i18n";
import {
  BundleSummary,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Input,
  PageHeader,
  Select,
  StatusPill,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  type ThemeChoice,
  TR,
  useTheme,
  useToast,
} from "@pama/ui";
import { FolderGit2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { draftApi } from "./api.ts";
import { ipc } from "./ipc.ts";

interface SyncProject {
  id: string;
  name: string;
  repo_key: string;
  sync_enabled: boolean;
  sync_target: string | null;
  bundles: {
    id: string;
    name: string;
    key: string | null;
    sync_enabled: boolean | null;
    branches: string[];
    session_count: number;
    last_activity: string | null;
  }[];
}

type Log = Awaited<ReturnType<typeof ipc.getNetworkLog>>;

function Section({ title, children, hint }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="space-y-3">
      <CardHeader title={title} description={hint} className="mb-0" />
      {children}
    </Card>
  );
}

/** One labelled row; the value is saved when the field loses focus. */
function Row({ label, children, id }: { label: string; children: ReactNode; id: string }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-3">
      <label htmlFor={id} className="text-ui text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onSave,
  secret,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
  secret?: boolean;
}) {
  const id = useId();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Row label={label} id={id}>
      <Input
        id={id}
        type={secret ? "password" : "text"}
        value={v}
        placeholder={secret && value ? "saved in the OS keychain" : ""}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onSave(v)}
      />
    </Row>
  );
}

export function Settings() {
  const { t: all, locale, setLocale } = useI18n();
  const t = all.desktop;
  const toast = useToast();
  const [theme, setTheme] = useTheme();
  const [s, setS] = useState<Record<string, string | boolean | null>>({});
  const [projects, setProjects] = useState<SyncProject[]>([]);
  const [log, setLog] = useState<Log>([]);
  const [serverLog, setServerLog] = useState<Log>([]);
  const answerId = useId();
  const themeId = useId();
  const langId = useId();
  const strictId = useId();

  const load = useCallback(async () => {
    setS(await ipc.getSettings());
    setProjects((await draftApi.syncStatus()).projects);
    setLog(await ipc.getNetworkLog(100));
    setServerLog((await draftApi.networkLog()).items);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (key: string, value: string) => {
    await ipc.setSetting(key, value);
    toast.success(all.common.saved, "Restart pamA to apply model changes.");
    await load();
  };
  const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : "");
  const strict = s.strict_offline === "true";
  const hosts = str("declared_hosts");
  const splitHosts = (v: string) =>
    v
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <PageHeader title={t.settingsTitle} className="mb-2" />

      <Section title={t.appearance}>
        <Row label={all.common.theme} id={themeId}>
          <Select
            id={themeId}
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeChoice)}
          >
            {(["system", "light", "dark"] as const).map((c) => (
              <option key={c} value={c}>
                {all.common.themes[c]}
              </option>
            ))}
          </Select>
        </Row>
        <Row label={all.common.language} id={langId}>
          <Select id={langId} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {all.common.languages[l]}
              </option>
            ))}
          </Select>
        </Row>
      </Section>

      <Section title={t.hotkey}>
        <Field
          label={t.shortcut}
          value={str("hotkey.accelerator")}
          onSave={async (v) => {
            const r = await ipc.setHotkey(v);
            if (r.ok) toast.success("Hotkey updated.");
            else toast.error("That shortcut is taken or invalid", r.error ?? undefined);
            await load();
          }}
        />
        <Row label={t.answerFrom} id={answerId}>
          <Select
            id={answerId}
            value={str("hotkey.answer_source") || "local"}
            onChange={(e) => save("hotkey.answer_source", e.target.value)}
          >
            <option value="local">This machine</option>
            <option value="server">Synced server</option>
            <option value="auto">Automatic</option>
          </Select>
        </Row>
      </Section>

      <Section
        title={t.models}
        hint="Local models (Ollama, vLLM) keep everything on your machine or network."
      >
        <Field
          label="Chat provider"
          value={str("provider.chat.provider")}
          onSave={(v) => save("provider.chat.provider", v)}
        />
        <Field
          label="Chat model"
          value={str("provider.chat.model")}
          onSave={(v) => save("provider.chat.model", v)}
        />
        <Field
          label="Chat base URL"
          value={str("provider.chat.base_url")}
          onSave={(v) => save("provider.chat.base_url", v)}
        />
        <Field
          label="Embedding model"
          value={str("provider.embed.model")}
          onSave={(v) => save("provider.embed.model", v)}
        />
        <Field
          label="Anthropic API key"
          value={s["provider.anthropic.key"] ? "•" : ""}
          secret
          onSave={(v) => v && save("provider.anthropic.key", v)}
        />
      </Section>

      <Section
        title={t.sync}
        hint="Off by default. Only approved digests are sent; turning sync off deletes the copies on the server."
      >
        <Field
          label="Server"
          value={str("sync.default_target")}
          onSave={(v) => save("sync.default_target", v)}
        />
        {projects.length === 0 && (
          <EmptyState
            icon={FolderGit2}
            title="No projects yet."
            description="Projects appear here after pamA ingests your first agent session."
          />
        )}
        <ul className="space-y-3">
          {projects.map((p) => (
            <li key={p.id} className="rounded-control border border-line p-3">
              <div className="flex items-center gap-2 text-ui font-medium">
                <Checkbox
                  id={`sync-${p.id}`}
                  checked={p.sync_enabled}
                  onCheckedChange={async (checked) => {
                    try {
                      await ipc.setSync(
                        "project",
                        p.id,
                        checked === true,
                        str("sync.default_target") || undefined,
                      );
                    } catch (err) {
                      toast.error(String(err));
                    }
                    await load();
                  }}
                />
                <label htmlFor={`sync-${p.id}`}>{p.name}</label>
                <span className="font-mono text-xs font-normal text-faint">{p.repo_key}</span>
              </div>
              <ul className="mt-2 space-y-2 pl-6">
                {p.bundles.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-start gap-2">
                    <Select
                      aria-label={`Sync for ${b.name}`}
                      className="w-36"
                      value={b.sync_enabled === null ? "inherit" : b.sync_enabled ? "on" : "off"}
                      onChange={async (e) => {
                        const v = e.target.value === "inherit" ? null : e.target.value === "on";
                        await ipc
                          .setSync("bundle", b.id, v, str("sync.default_target") || undefined)
                          .catch((err) => toast.error(String(err)));
                        await load();
                      }}
                    >
                      <option value="inherit">as project</option>
                      <option value="on">sync</option>
                      <option value="off">never sync</option>
                    </Select>
                    <BundleSummary bundle={b} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title={t.strictOffline}
        hint="Blocks every connection pamA makes except to the hosts below, and logs each one. Other programs (Ollama, tunnels) are not covered."
      >
        <div className="flex items-center gap-2 text-ui">
          <Switch
            id={strictId}
            checked={strict}
            onCheckedChange={async (checked) => {
              await ipc.setStrictOffline(checked, splitHosts(hosts));
              toast.success(all.common.saved, "Restart pamA to apply to the server.");
              await load();
            }}
          />
          <label htmlFor={strictId}>Block undeclared hosts</label>
        </div>
        <Field
          label="Declared hosts"
          value={hosts}
          onSave={async (v) => {
            await ipc.setStrictOffline(strict, splitHosts(v));
            await load();
          }}
        />
        <h3 className="pt-2 text-sm font-semibold">{t.networkLog}</h3>
        <Table label={t.networkLog} className="text-xs">
          <THead>
            <tr>
              <TH>When</TH>
              <TH>From</TH>
              <TH>Host</TH>
              <TH>Purpose</TH>
              <TH>Allowed</TH>
            </tr>
          </THead>
          <TBody>
            {[
              ...log.map((l) => ({ ...l, at: new Date(l.at).toISOString() })),
              ...serverLog.map((l) => ({ ...l, at: String(l.at) })),
            ]
              .sort((a, b) => (a.at < b.at ? 1 : -1))
              .slice(0, 200)
              .map((l) => (
                <TR key={`${l.component}-${l.id}`}>
                  <TD className="whitespace-nowrap">{new Date(l.at).toLocaleString()}</TD>
                  <TD>{l.component}</TD>
                  <TD className="font-mono">{l.host}</TD>
                  <TD>{l.purpose}</TD>
                  <TD>
                    {l.allowed ? (
                      <StatusPill tone="success">yes</StatusPill>
                    ) : (
                      <StatusPill tone="danger">blocked</StatusPill>
                    )}
                  </TD>
                </TR>
              ))}
          </TBody>
        </Table>
      </Section>
    </div>
  );
}
