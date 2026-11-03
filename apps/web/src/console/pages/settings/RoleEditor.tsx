// Change one role's model (spec 003/005). Providers come from the shared registry; the server's
// confirmation gates (data leaves, re-index, unverified) are asked in a confirm dialog that says
// exactly what will happen, then the save is retried with that confirmation.
import { useI18n } from "@pama/i18n";
import {
  Button,
  DialogFooter,
  ErrorBanner,
  Field,
  Input,
  Notice,
  Select,
  StatusPill,
  useConfirm,
  useToast,
} from "@pama/ui";
import { CircleAlert, CircleCheck, ShieldAlert } from "lucide-react";
import { useId, useState } from "react";
import { ApiError, api, errorMessage } from "../../../lib/api.ts";
import type { Check, EffectiveRole, Gate, Role, RoleSettings } from "./data.ts";
import { providerById, providerLabel, providersFor } from "./registry.ts";

export function CheckList({ check }: { check: Check }) {
  const { t } = useI18n();
  const m = t.pages.settings.models;
  return (
    <ul className="space-y-1 text-ui">
      {check.items.map((i) => (
        <li
          key={i.name}
          className={`flex items-start gap-2 ${i.ok ? "text-success-ink" : "text-danger-ink"}`}
        >
          {i.ok ? (
            <CircleCheck aria-label={m.checkOk(null)} className="mt-0.5 size-4 shrink-0" />
          ) : (
            <CircleAlert aria-label={m.checkFailed} className="mt-0.5 size-4 shrink-0" />
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

export function RoleEditor({
  role,
  current,
  settings,
  strict,
  tenant,
  onDone,
}: {
  role: Role;
  current: EffectiveRole;
  settings: RoleSettings | undefined;
  strict: boolean;
  tenant: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const e = t.pages.settings.editor;
  const toast = useToast();
  const ask = useConfirm();
  const choices = providersFor(role, tenant);
  const start = choices.some((p) => p.id === current.preset)
    ? current.preset
    : (choices[0]?.id ?? current.preset);
  const [provider, setProvider] = useState(start);
  const [model, setModel] = useState(start === current.preset ? current.model : "");
  const def = providerById(provider)?.default_base_url ?? null;
  const [baseUrl, setBaseUrl] = useState(
    start === current.preset && current.base_url && current.base_url !== def
      ? current.base_url
      : "",
  );
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const listId = useId();

  const p = providerById(provider);
  const wantsUrl = provider === "openai-compatible" || (p?.default_base_url ?? null) !== null;
  const wantsKey = p?.needs_key || provider === "openai-compatible";
  const keySaved = provider === current.preset && current.key_set;
  const cloud = p?.locality !== "local";

  const draft = () => ({
    provider,
    model: model.trim(),
    ...(wantsUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(apiKey ? { apiKey } : {}),
  });

  async function save(confirm: Gate[] = []): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ check?: Check }>(`/v1/models/settings/${role}`, {
        method: "PUT",
        json: { ...draft(), confirm },
      });
      if (r.check) setCheck(r.check);
      toast.success(e.saved);
      onDone();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === "confirmation_required") {
        const required = ((err.body as { required?: Gate[] })?.required ?? []).filter(
          (g) => !confirm.includes(g),
        );
        const ok = await ask({
          title: e.confirmTitle,
          description: (
            <span className="block space-y-2">
              {required.map((g) => (
                <span key={g} className="block">
                  {e.gates[g] ?? err.message}
                </span>
              ))}
            </span>
          ),
          confirmLabel: e.confirmSave,
        });
        if (ok) return save([...confirm, ...required]);
        return;
      }
      if (err instanceof ApiError && err.code === "check_failed") {
        const c = (err.body as { check?: Check })?.check;
        if (c) setCheck(c);
        const ok = await ask({
          title: e.unverifiedTitle,
          description: e.unverifiedBody(err.message),
          confirmLabel: e.saveAnyway,
          danger: true,
        });
        if (ok) return save([...confirm, "unverified"]);
        return;
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError(null);
    try {
      setCheck(await api<Check>("/v1/models/check", { json: { role, candidate: draft() } }));
    } catch (err) {
      setError(`${e.testFailed}: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function revert() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/models/settings/${role}/revert`, { method: "POST", json: {} });
      toast.success(e.reverted);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const previous = tenant
    ? current.scope === "workspace"
      ? t.pages.settings.home.cloud
      : null
    : settings?.previous
      ? `${providerLabel(settings.previous.provider)} / ${settings.previous.model}`
      : null;

  return (
    <form
      className="space-y-4"
      onSubmit={(ev) => {
        ev.preventDefault();
        void save();
      }}
    >
      <Field label={e.provider}>
        <Select
          value={provider}
          onChange={(ev) => {
            const next = ev.target.value;
            setProvider(next);
            setModel(
              next === current.preset
                ? current.model
                : (providerById(next)?.suggested[role]?.[0] ?? ""),
            );
            setBaseUrl("");
            setApiKey("");
            setCheck(null);
          }}
        >
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={e.model}>
        <Input
          value={model}
          required
          list={listId}
          autoComplete="off"
          onChange={(ev) => setModel(ev.target.value)}
        />
      </Field>
      <datalist id={listId}>
        {(p?.suggested[role] ?? []).map((h) => (
          <option key={h} value={h} />
        ))}
      </datalist>
      {wantsUrl && (
        <Field label={e.endpoint} hint={def ? e.endpointDefault(def) : undefined}>
          <Input
            type="url"
            value={baseUrl}
            placeholder={def ?? "https://…"}
            onChange={(ev) => setBaseUrl(ev.target.value)}
          />
        </Field>
      )}
      {wantsKey && (
        <Field
          label={e.apiKey}
          hint={e.keyHint}
          labelAside={
            keySaved ? (
              <StatusPill tone="success">{e.keySet}</StatusPill>
            ) : (
              <StatusPill tone="warning">{e.keyMissing}</StatusPill>
            )
          }
        >
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={keySaved ? e.keyKeep : ""}
            onChange={(ev) => setApiKey(ev.target.value)}
          />
        </Field>
      )}
      {provider === "openrouter" && <p className="text-ui text-muted">{e.openRouterHint}</p>}
      {strict && cloud && (
        <Notice tone="warning" icon={ShieldAlert}>
          {t.pages.settings.models.strictOffline}
        </Notice>
      )}
      {error && <ErrorBanner title={e.saveFailed} message={error} />}
      {check && <CheckList check={check} />}
      <DialogFooter className="justify-between">
        {previous ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={revert}>
            {e.revert(previous)}
          </Button>
        ) : (
          <span />
        )}
        <span className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy || !model.trim()} onClick={test}>
            {e.test}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!model.trim()}>
            {e.save}
          </Button>
        </span>
      </DialogFooter>
    </form>
  );
}
