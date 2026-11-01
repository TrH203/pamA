// Model settings (spec 003): chat, small and embedding roles. Talks to /v1/models/*; the CLI
// (`pama model`) uses the same endpoints, so both always show the same values.
import { useI18n } from "@pama/i18n";
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Notice,
  Select,
  SkeletonList,
  StatusPill,
  useToast,
} from "@pama/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Cloud, Laptop, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "../lib/api.ts";

export type Role = "chat" | "small" | "embed";
type Confirm = "data_leaves" | "reindex" | "unverified";

interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}
interface Check {
  ok: boolean;
  latencyMs: number | null;
  items: CheckItem[];
}
export interface RoleView {
  scope?: "server" | "workspace";
  provider: string;
  model: string;
  baseUrl?: string;
  keySet: boolean;
  local: boolean;
  verified: boolean;
  source: "env" | "saved";
  previous?: { provider: string; model: string; baseUrl?: string };
  lastCheck?: Check;
}
export interface Settings {
  strict_offline: boolean;
  roles: Record<Role, RoleView>;
}

const TITLES: Record<Role, [string, string]> = {
  chat: ["Chat", "Answers and drafts"],
  small: ["Small (advanced)", "Digest, classifier, judge"],
  embed: ["Embedding", "Search and retrieval"],
};
const PROVIDERS = [
  ["ollama", "Ollama (local)"],
  ["openai-compatible", "OpenAI-compatible (vLLM, LM Studio, cloud…)"],
  ["openrouter", "OpenRouter (cloud, many models, one key)"],
  ["anthropic", "Anthropic (cloud)"],
] as const;
/** Starting points for the model field; any model id the provider serves works. */
const MODEL_HINTS: Record<string, string[]> = {
  openrouter: [
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash",
    "qwen/qwen3-14b",
  ],
  anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  ollama: ["qwen3:14b", "bge-m3"],
};
const NOTICE: Record<string, string> = {
  data_leaves:
    "This sends digest content and questions to a cloud provider. Raw transcripts never leave your machine.",
  reindex: "Changing the embedding model re-indexes all stored digest items.",
};

function CheckList({ check }: { check: Check }) {
  return (
    <ul className="space-y-1 text-ui">
      {check.items.map((i) => (
        <li
          key={i.name}
          className={`flex items-start gap-2 ${i.ok ? "text-success-ink" : "text-danger-ink"}`}
        >
          {i.ok ? (
            <CircleCheck aria-label="OK" className="mt-0.5 size-4 shrink-0" />
          ) : (
            <CircleAlert aria-label="Failed" className="mt-0.5 size-4 shrink-0" />
          )}
          <span>
            {i.detail}
            {i.fix && <span className="opacity-80"> — {i.fix}</span>}
          </span>
        </li>
      ))}
      {check.latencyMs !== null && <li className="pl-6 text-muted">{check.latencyMs} ms</li>}
    </ul>
  );
}

export function RoleCard({
  role,
  v,
  strict,
  onSaved,
  preset,
}: {
  role: Role;
  v: RoleView;
  strict: boolean;
  onSaved: () => void;
  /** Switch the form to this provider (a quick choice made elsewhere on the page). */
  preset?: string;
}) {
  const [provider, setProvider] = useState(v.provider);
  const [model, setModel] = useState(v.model);
  const [baseUrl, setBaseUrl] = useState(v.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(v.lastCheck ?? null);
  const [needs, setNeeds] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [title, sub] = TITLES[role];
  const toast = useToast();
  const wantsUrl = provider !== "anthropic";
  const hints = MODEL_HINTS[provider] ?? [];
  const wantsKey = provider !== "ollama";

  useEffect(() => {
    if (!preset) return;
    setProvider(preset);
    setBaseUrl("");
    setApiKey("");
  }, [preset]);

  // Follow the server when the settings change elsewhere (CLI, revert).
  useEffect(() => {
    setProvider(v.provider);
    setModel(v.model);
    setBaseUrl(v.baseUrl ?? "");
    setApiKey("");
  }, [v.provider, v.model, v.baseUrl]);

  const draft = () => ({
    provider,
    model,
    ...(wantsUrl && baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  });

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError) {
        const b = e.body as { required?: string[]; check?: Check } | undefined;
        if (e.code === "confirmation_required") setNeeds(b?.required ?? []);
        else {
          setError(e.message);
          setFailed(e.code === "check_failed");
          if (b?.check) setCheck(b.check);
        }
      } else setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const save = (confirm: Confirm[] = []) =>
    run(async () => {
      const r = await api<RoleView & { check: Check }>(`/v1/models/settings/${role}`, {
        method: "PUT",
        json: { ...draft(), confirm },
      });
      setCheck(r.check);
      setNeeds([]);
      setFailed(false);
      toast.success("Model saved");
      onSaved();
    });
  const test = () =>
    run(async () =>
      setCheck(await api<Check>("/v1/models/check", { json: { role, candidate: draft() } })),
    );
  const revert = () =>
    run(async () => {
      await api(`/v1/models/settings/${role}/revert`, { method: "POST", json: {} });
      setCheck(null);
      onSaved();
    });

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-ui text-muted">{sub}</span>
        <span className="ml-auto flex gap-1">
          <StatusPill tone="neutral" icon={v.local ? Laptop : Cloud}>
            {v.local ? "local" : "cloud"}
          </StatusPill>
          {v.source === "env" ? (
            <StatusPill tone="neutral">default</StatusPill>
          ) : v.verified ? (
            <StatusPill tone="success">verified</StatusPill>
          ) : (
            <StatusPill tone="warning">unverified</StatusPill>
          )}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model">
          <Input value={model} list={`models-${role}`} onChange={(e) => setModel(e.target.value)} />
        </Field>
        <datalist id={`models-${role}`}>
          {hints.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
        {wantsUrl && (
          <Field
            label="Endpoint"
            hint={
              provider === "ollama"
                ? "Default http://127.0.0.1:11434"
                : provider === "openrouter"
                  ? "Default https://openrouter.ai/api/v1"
                  : undefined
            }
          >
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…"
            />
          </Field>
        )}
        {wantsKey && (
          <Field
            label="API key"
            labelAside={
              v.keySet && provider === v.provider ? (
                <StatusPill tone="success">set</StatusPill>
              ) : (
                <StatusPill tone="warning">not set</StatusPill>
              )
            }
            hint="Write-only: the saved key is never shown."
          >
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={v.keySet && provider === v.provider ? "leave empty to keep" : ""}
            />
          </Field>
        )}
      </div>
      {provider === "openrouter" && (
        <p className="text-ui text-muted">
          Create a key at{" "}
          <a
            className="text-accent-ink underline underline-offset-2"
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer"
          >
            openrouter.ai/keys
          </a>
          . Use model ids like <code>vendor/model</code>. Your OpenRouter privacy settings decide
          which upstream providers may see the prompts.
        </p>
      )}
      {strict && provider !== "ollama" && (
        <Notice tone="warning" icon={ShieldAlert}>
          Strict offline is on: cloud endpoints are blocked unless declared.
        </Notice>
      )}
      {needs.length > 0 && (
        <Notice tone="warning">
          <div className="space-y-2">
            {needs.map((n) => (
              <p key={n}>{NOTICE[n] ?? n}</p>
            ))}
            <Button variant="primary" loading={busy} onClick={() => save(needs as Confirm[])}>
              Confirm and save
            </Button>
          </div>
        </Notice>
      )}
      {error && (
        <ErrorBanner
          title="Couldn't save"
          message={error}
          onRetry={failed ? () => save(["unverified"]) : undefined}
          retryLabel="Save anyway"
        />
      )}
      {check && <CheckList check={check} />}
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Button variant="primary" loading={busy} disabled={!model} onClick={() => save()}>
          Save
        </Button>
        <Button disabled={busy || !model} onClick={test}>
          Test
        </Button>
        {v.previous && (
          <Button variant="ghost" disabled={busy} onClick={revert}>
            Revert to {v.previous.provider} / {v.previous.model}
          </Button>
        )}
      </div>
    </Card>
  );
}

export function Models() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["models"],
    queryFn: () => api<Settings>("/v1/models/settings"),
  });
  const load = () => {
    void qc.invalidateQueries({ queryKey: ["models"] });
    void qc.invalidateQueries({ queryKey: ["placement"] });
  };
  if (q.isError)
    return (
      <ErrorBanner
        title={t.common.loadFailed}
        message={errorMessage(q.error)}
        onRetry={() => void q.refetch()}
        retryLabel={t.common.retry}
      />
    );
  if (!q.data) return <SkeletonList label={t.common.loading} />;
  const s = q.data;
  return (
    <section className="space-y-4">
      {s.strict_offline && <StatusPill tone="warning">strict offline</StatusPill>}
      {(["chat", "embed", "small"] as Role[]).map((r) => (
        <RoleCard key={r} role={r} v={s.roles[r]} strict={s.strict_offline} onSaved={load} />
      ))}
    </section>
  );
}
