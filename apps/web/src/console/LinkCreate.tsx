// Create an Ask Link in under a minute (SC-004): type the question or keywords, keep the
// suggested sources (sensitive ones start unchecked), adjust settings, share.
import {
  Badge,
  Button,
  buttonClass,
  Checkbox,
  ErrorBanner,
  Field,
  Input,
  Notice,
  Select,
  Textarea,
  useToast,
} from "@pama/ui";
import { CircleCheck, Copy, ExternalLink, Plus, Sparkles, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../lib/api.ts";

interface Suggestion {
  ref: { type: "bundle"; id: string };
  title: string;
  project: string;
  score: number;
  sessions: number;
  date_range: { from: string | null; to: string | null };
  flagged_labels: string[];
  preselected: boolean;
}

interface Created {
  slug: string;
  url: string;
  pin?: string;
  suggested_questions: string[];
}

const LABELS = ["business_sensitive", "infra", "customer"] as const;

export function LinkCreate({
  initialQuery = "",
  onCreated,
}: {
  initialQuery?: string;
  onCreated?: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [sources, setSources] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expires, setExpires] = useState("7d");
  const [detail, setDetail] = useState("summary");
  const [access, setAccess] = useState("pin");
  const [pin, setPin] = useState("");
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState<Set<string>>(new Set());
  const [topics, setTopics] = useState("");
  const [instruction, setInstruction] = useState("");
  const [rate, setRate] = useState(30);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const toast = useToast();

  async function suggest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuggesting(true);
    try {
      const r = await api<{ sources: Suggestion[] }>("/v1/suggest", { json: { query } });
      setSources(r.sources);
      setPicked(new Set(r.sources.filter((s) => s.preselected).map((s) => s.ref.id)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSuggesting(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        sources: (sources ?? []).filter((s) => picked.has(s.ref.id)).map((s) => s.ref),
        expires,
        detail,
        access_mode: access,
        ...(access === "pin" && pin ? { pin } : {}),
        ...(access === "allowlist" ? { allowlist: allow.split(/[\s,]+/).filter(Boolean) } : {}),
        deny_labels: [...deny],
        deny_topics: topics
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        ...(instruction.trim() ? { instruction } : {}),
        rate_limit_per_hour: rate,
      };
      setCreated(await api<Created>("/v1/links", { json: body }));
      onCreated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const share = created.pin ? `${created.url}\nPIN: ${created.pin}` : created.url;
    return (
      <section className="space-y-4">
        <Notice tone="success" icon={CircleCheck}>
          <span className="font-medium">Link ready.</span> Share it with the people who should ask.
        </Notice>
        <pre className="whitespace-pre-wrap break-all rounded-control border border-line bg-subtle p-3 font-mono text-ui">
          {share}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              await navigator.clipboard.writeText(share);
              toast.success("Copied");
            }}
          >
            <Copy aria-hidden />
            Copy
          </Button>
          <a
            className={buttonClass("secondary")}
            href={created.url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink aria-hidden />
            Open
          </a>
          <Button onClick={() => setCreated(null)}>
            <Plus aria-hidden />
            New link
          </Button>
        </div>
        {created.suggested_questions.length > 0 && (
          <div className="space-y-1 text-ui">
            <p className="font-medium">Suggested questions shown to askers</p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted">
              {created.suggested_questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  }

  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  return (
    <section className="space-y-5">
      <form onSubmit={suggest} className="flex flex-col gap-2 sm:flex-row">
        <Input
          className="h-10 flex-1 text-sm"
          placeholder="What will people ask about? e.g. refund shipping fee"
          aria-label="Question or keywords"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          type="submit"
          size="lg"
          variant={sources ? "secondary" : "primary"}
          loading={suggesting}
          disabled={!query.trim()}
        >
          <Sparkles aria-hidden />
          Suggest sources
        </Button>
      </form>

      {sources && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-ui font-medium">Sources ({picked.size} selected)</legend>
          {sources.length === 0 && <p className="text-ui text-muted">No approved digests yet.</p>}
          <ul className="divide-y divide-line rounded-control border border-line">
            {sources.map((s) => (
              <li key={s.ref.id} className="flex items-center gap-3 px-3 py-2.5 text-ui">
                <Checkbox
                  id={`src-${s.ref.id}`}
                  checked={picked.has(s.ref.id)}
                  onCheckedChange={() => setPicked((p) => toggle(p, s.ref.id))}
                />
                <label htmlFor={`src-${s.ref.id}`} className="min-w-0 flex-1">
                  <span className="font-medium">{s.title}</span>{" "}
                  <span className="text-muted">
                    {s.project} · {s.sessions} session(s)
                  </span>
                  {s.flagged_labels.length > 0 && (
                    <Badge tone="warning" className="ml-2">
                      <TriangleAlert aria-hidden />
                      {s.flagged_labels.join(", ").replaceAll("_", " ")}
                    </Badge>
                  )}
                </label>
                <span className="text-xs tabular-nums text-faint">
                  {Math.round(s.score * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      {sources && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expires">
            <Select value={expires} onChange={(e) => setExpires(e.target.value)}>
              {["1d", "7d", "30d", "90d"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Detail">
            <Select value={detail} onChange={(e) => setDetail(e.target.value)}>
              <option value="headline">Headline</option>
              <option value="summary">Summary</option>
              <option value="technical">Technical</option>
            </Select>
          </Field>
          <Field label="Access">
            <Select value={access} onChange={(e) => setAccess(e.target.value)}>
              <option value="pin">PIN</option>
              <option value="open">Anyone with the link</option>
              <option value="email_otp">Email code</option>
              <option value="allowlist">Email allowlist</option>
            </Select>
          </Field>
          {access === "pin" && (
            <Field label="PIN" hint="Leave empty to generate one.">
              <Input
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
          )}
          {access === "allowlist" && (
            <Field label="Allowed emails or *@domain" className="sm:col-span-2">
              <Input
                value={allow}
                onChange={(e) => setAllow(e.target.value)}
                placeholder="pm@client.com, *@acme.vn"
              />
            </Field>
          )}
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-ui font-medium">Never share items labelled</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {LABELS.map((l) => (
                <span key={l} className="inline-flex items-center gap-2 text-ui">
                  <Checkbox
                    id={`deny-${l}`}
                    checked={deny.has(l)}
                    onCheckedChange={() => setDeny((d) => toggle(d, l))}
                  />
                  <label htmlFor={`deny-${l}`}>{l.replace("_", " ")}</label>
                </span>
              ))}
            </div>
          </fieldset>
          <Field label="Denied topics" hint="Comma separated.">
            <Input
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder="pricing, roadmap"
            />
          </Field>
          <Field label="Instruction for answers (optional)" className="sm:col-span-2">
            <Textarea
              rows={2}
              maxLength={2000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Be brief; the asker is from QA."
            />
          </Field>
          <Field label="Questions per hour">
            <Input
              type="number"
              min={1}
              max={500}
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            />
          </Field>
        </div>
      )}
      {error && <ErrorBanner title="Couldn't create the link" message={error} />}
      {sources && (
        <div className="flex justify-end border-t border-line pt-4">
          <Button variant="primary" loading={busy} disabled={picked.size === 0} onClick={create}>
            Create link
          </Button>
        </div>
      )}
    </section>
  );
}
