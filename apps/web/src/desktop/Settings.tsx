// Desktop settings (US4): sync per source (off by default), strict offline mode with declared
// hosts and the network log, model providers, hotkey and answer source.
import { useCallback, useEffect, useState } from "react";
import { draftApi } from "./api.ts";
import { ipc } from "./ipc.ts";

interface SyncProject {
  id: string;
  name: string;
  repo_key: string;
  sync_enabled: boolean;
  sync_target: string | null;
  bundles: { id: string; name: string; sync_enabled: boolean | null }[];
}

type Log = Awaited<ReturnType<typeof ipc.getNetworkLog>>;

function Section({
  title,
  children,
  hint,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {hint && <p className="text-xs text-stone-500">{hint}</p>}
      </div>
      {children}
    </section>
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
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-40 shrink-0 text-stone-600">{label}</span>
      <input
        className="flex-1 rounded border border-stone-300 px-2 py-1"
        type={secret ? "password" : "text"}
        value={v}
        placeholder={secret && value ? "saved in the OS keychain" : ""}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onSave(v)}
      />
    </label>
  );
}

export function Settings() {
  const [s, setS] = useState<Record<string, string | boolean | null>>({});
  const [projects, setProjects] = useState<SyncProject[]>([]);
  const [log, setLog] = useState<Log>([]);
  const [serverLog, setServerLog] = useState<Log>([]);
  const [msg, setMsg] = useState<string | null>(null);

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
    setMsg("Saved. Restart pamA to apply model changes.");
    await load();
  };
  const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : "");
  const strict = s.strict_offline === "true";
  const hosts = str("declared_hosts");

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 text-sm">
      <h1 className="text-xl font-bold">Settings</h1>
      {msg && <p className="rounded bg-emerald-50 p-2 text-emerald-900">{msg}</p>}

      <Section title="Hotkey">
        <Field
          label="Shortcut"
          value={str("hotkey.accelerator")}
          onSave={async (v) => {
            const r = await ipc.setHotkey(v);
            setMsg(
              r.ok ? "Hotkey updated." : `That shortcut is taken or invalid: ${r.error ?? ""}`,
            );
            await load();
          }}
        />
        <label className="flex items-center gap-2">
          <span className="w-40 text-stone-600">Answer from</span>
          <select
            className="rounded border border-stone-300 px-2 py-1"
            value={str("hotkey.answer_source") || "local"}
            onChange={(e) => save("hotkey.answer_source", e.target.value)}
          >
            <option value="local">This machine</option>
            <option value="server">Synced server</option>
            <option value="auto">Automatic</option>
          </select>
        </label>
      </Section>

      <Section
        title="Models"
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
        title="Sync"
        hint="Off by default. Only approved digests are sent; turning sync off deletes the copies on the server."
      >
        <Field
          label="Server"
          value={str("sync.default_target")}
          onSave={(v) => save("sync.default_target", v)}
        />
        {projects.length === 0 && <p className="text-stone-500">No projects yet.</p>}
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={p.sync_enabled}
                  onChange={async (e) => {
                    try {
                      await ipc.setSync(
                        "project",
                        p.id,
                        e.target.checked,
                        str("sync.default_target") || undefined,
                      );
                    } catch (err) {
                      setMsg(String(err));
                    }
                    await load();
                  }}
                />
                {p.name} <span className="text-xs font-normal text-stone-400">{p.repo_key}</span>
              </label>
              <ul className="ml-6 mt-1 space-y-1">
                {p.bundles.map((b) => (
                  <li key={b.id} className="flex items-center gap-2">
                    <select
                      className="rounded border border-stone-300 px-1 py-0.5 text-xs"
                      value={b.sync_enabled === null ? "inherit" : b.sync_enabled ? "on" : "off"}
                      onChange={async (e) => {
                        const v = e.target.value === "inherit" ? null : e.target.value === "on";
                        await ipc
                          .setSync("bundle", b.id, v, str("sync.default_target") || undefined)
                          .catch((err) => setMsg(String(err)));
                        await load();
                      }}
                    >
                      <option value="inherit">as project</option>
                      <option value="on">sync</option>
                      <option value="off">never sync</option>
                    </select>
                    {b.name}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Strict offline mode"
        hint="Blocks every connection pamA makes except to the hosts below, and logs each one. Other programs (Ollama, tunnels) are not covered."
      >
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={strict}
            onChange={async (e) => {
              await ipc.setStrictOffline(
                e.target.checked,
                hosts
                  .split(",")
                  .map((h) => h.trim())
                  .filter(Boolean),
              );
              setMsg("Saved. Restart pamA to apply to the server.");
              await load();
            }}
          />
          Block undeclared hosts
        </label>
        <Field
          label="Declared hosts"
          value={hosts}
          onSave={async (v) => {
            await ipc.setStrictOffline(
              strict,
              v
                .split(",")
                .map((h) => h.trim())
                .filter(Boolean),
            );
            await load();
          }}
        />
        <h3 className="pt-2 font-medium">Network log</h3>
        <table className="w-full text-left text-xs">
          <thead className="text-stone-500">
            <tr>
              <th>When</th>
              <th>From</th>
              <th>Host</th>
              <th>Purpose</th>
              <th>Allowed</th>
            </tr>
          </thead>
          <tbody>
            {[
              ...log.map((l) => ({ ...l, at: new Date(l.at).toISOString() })),
              ...serverLog.map((l) => ({ ...l, at: String(l.at) })),
            ]
              .sort((a, b) => (a.at < b.at ? 1 : -1))
              .slice(0, 200)
              .map((l) => (
                <tr key={`${l.component}-${l.id}`} className={l.allowed ? "" : "text-red-700"}>
                  <td>{new Date(l.at).toLocaleString()}</td>
                  <td>{l.component}</td>
                  <td>{l.host}</td>
                  <td>{l.purpose}</td>
                  <td>{l.allowed ? "yes" : "blocked"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
