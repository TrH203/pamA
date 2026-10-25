// Model settings (spec 003): chat, small and embedding roles. Talks to /v1/models/*; the CLI
// (`pama model`) uses the same endpoints, so both always show the same values.
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../lib/api.ts";

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

function Badge({ ok, children }: { ok: boolean | null; children: string }) {
  const tone =
    ok === null
      ? "bg-stone-200 text-stone-700"
      : ok
        ? "bg-green-100 text-green-800"
        : "bg-red-100 text-red-800";
  return <span className={`rounded px-2 py-0.5 text-xs ${tone}`}>{children}</span>;
}

function CheckList({ check }: { check: Check }) {
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {check.items.map((i) => (
        <li key={i.name} className={i.ok ? "text-green-700" : "text-red-700"}>
          <span aria-hidden>{i.ok ? "✓" : "✗"}</span> {i.detail}
          {i.fix && <span className="opacity-80"> — {i.fix}</span>}
        </li>
      ))}
      {check.latencyMs !== null && <li className="text-stone-500">{check.latencyMs} ms</li>}
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
    <section className="space-y-3 rounded border border-stone-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{title}</h3>
        <span className="text-sm text-stone-500">{sub}</span>
        <span className="ml-auto flex gap-1">
          <Badge ok={null}>{v.local ? "local" : "cloud"}</Badge>
          <Badge ok={v.source === "saved" ? v.verified : null}>
            {v.source === "env" ? "default" : v.verified ? "verified" : "unverified"}
          </Badge>
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Provider
          <select
            className="input mt-1 w-full"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {PROVIDERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Model
          <input
            className="input mt-1 w-full"
            value={model}
            list={`models-${role}`}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id={`models-${role}`}>
            {hints.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </label>
        {wantsUrl && (
          <label className="text-sm">
            Endpoint{" "}
            {provider === "ollama" && (
              <span className="text-stone-500">(default http://127.0.0.1:11434)</span>
            )}
            {provider === "openrouter" && (
              <span className="text-stone-500">(default https://openrouter.ai/api/v1)</span>
            )}
            <input
              className="input mt-1 w-full"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
        )}
        {wantsKey && (
          <label className="text-sm">
            API key{" "}
            {v.keySet && provider === v.provider ? (
              <Badge ok>set</Badge>
            ) : (
              <Badge ok={false}>not set</Badge>
            )}
            <input
              className="input mt-1 w-full"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={v.keySet && provider === v.provider ? "leave empty to keep" : ""}
            />
          </label>
        )}
      </div>
      {provider === "openrouter" && (
        <p className="text-sm text-stone-600">
          Create a key at{" "}
          <a
            className="underline"
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
        <p className="text-sm text-amber-700">
          Strict offline is on: cloud endpoints are blocked unless declared.
        </p>
      )}
      {needs.length > 0 && (
        <div className="space-y-2 rounded bg-amber-50 p-3 text-sm">
          {needs.map((n) => (
            <p key={n}>{NOTICE[n] ?? n}</p>
          ))}
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => save(needs as Confirm[])}
          >
            Confirm and save
          </button>
        </div>
      )}
      {error && (
        <p className="text-sm text-red-700">
          {error}{" "}
          {failed && (
            <button type="button" className="underline" onClick={() => save(["unverified"])}>
              Save anyway
            </button>
          )}
        </p>
      )}
      {check && <CheckList check={check} />}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !model}
          onClick={() => save()}
        >
          Save
        </button>
        <button type="button" className="btn" disabled={busy || !model} onClick={test}>
          Test
        </button>
        {v.previous && (
          <button type="button" className="btn" disabled={busy} onClick={revert}>
            Revert to {v.previous.provider} / {v.previous.model}
          </button>
        )}
      </div>
    </section>
  );
}

export function Models() {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Settings>("/v1/models/settings")
      .then(setS)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  if (err) return <p className="text-red-700">{err}</p>;
  if (!s) return <p className="text-stone-500">Loading…</p>;
  return (
    <section className="space-y-4">
      {s.strict_offline && <Badge ok={null}>strict offline</Badge>}
      {(["chat", "embed", "small"] as Role[]).map((r) => (
        <RoleCard key={r} role={r} v={s.roles[r]} strict={s.strict_offline} onSaved={load} />
      ))}
    </section>
  );
}
