// Where each part of pamA runs, and where it could run instead (Settings → Where things run).
// Derived from the server's configuration, so the page can never disagree with what is running.
import type { Deps } from "../app.ts";
import type { ProviderConfig } from "../config.ts";
import { isLocal, OPENROUTER_DEFAULT } from "../llm/providers.ts";

/** device: the owner's machine · server: the machine running this server · cloud: a hosted service */
export type Place = "device" | "server" | "cloud";

export interface PlaceOption {
  place: Place;
  /** How to choose it. */
  how: string;
}

export interface Component {
  id: string;
  name: string;
  what: string;
  /** Fixed components cannot be moved off the device; flexible ones can. */
  movable: boolean;
  current: Place;
  detail: string;
  options: PlaceOption[];
}

export interface Topology {
  mode: Deps["config"]["mode"];
  baseUrl: string;
  db: string;
  strictOffline: boolean;
  declaredHosts: string[];
  components: Component[];
  /** One line per kind of data that leaves the machine running this server, or why none does. */
  dataFlow: string[];
}

function hostOf(p: ProviderConfig): string {
  if (p.baseUrl) return new URL(p.baseUrl).host;
  if (p.provider === "openrouter") return new URL(OPENROUTER_DEFAULT).host;
  if (p.provider === "anthropic") return "api.anthropic.com";
  return "127.0.0.1:11434";
}

const PLACE_LABEL: Record<Place, string> = {
  device: "your machine",
  server: "this server",
  cloud: "a cloud service",
};

const MODEL_OPTIONS = (note: string): PlaceOption[] => [
  {
    place: "server",
    how: `Ollama, vLLM or LM Studio on your machine or LAN. Nothing leaves. ${note}`,
  },
  {
    place: "cloud",
    how: `Anthropic, OpenRouter or any OpenAI-compatible API, with a key. ${note}`,
  },
];

/** `redact`: a tenant on a shared server does not see the operator's endpoints. */
function modelComponent(
  deps: Deps,
  redact: boolean,
  c: { id: string; name: string; what: string; p: ProviderConfig; note: string },
): Component {
  const { p } = c;
  const local = isLocal(p);
  const place: Place = !local || deps.config.mode === "cloud" ? "cloud" : "server";
  const via = redact ? p.provider : `${p.provider} at ${hostOf(p)}`;
  return {
    id: c.id,
    name: c.name,
    what: c.what,
    movable: true,
    current: place,
    detail: `${p.model} via ${via}, on ${PLACE_LABEL[place]}.`,
    options: MODEL_OPTIONS(c.note),
  };
}

export function buildTopology(
  deps: Deps,
  opts: { redact: boolean; chat?: ProviderConfig },
): Topology {
  const { config } = deps;
  const chat = opts.chat ?? config.chat;
  const { mode } = config;
  const home: Place = mode === "cloud" ? "cloud" : "server";
  const dbDetail: Record<typeof mode, string> = {
    local: "An embedded database (PGlite) in this machine's pamA data folder.",
    selfhost: "Your own Postgres with pgvector, reached through DATABASE_URL.",
    cloud: "The hosted Postgres of this pamA Cloud server.",
  };
  const reach = new URL(config.baseUrl);

  const components: Component[] = [
    {
      id: "capture",
      name: "Capture and redaction",
      what: "Reads Claude Code and Codex sessions, removes secrets, keeps raw transcripts.",
      movable: false,
      current: "device",
      detail: "The `pama` binary on your machine. Raw transcripts never leave it, in any mode.",
      options: [{ place: "device", how: "Always. This is the privacy boundary, not a setting." }],
    },
    {
      id: "cli",
      name: "CLI and desktop hotkey",
      what: "`pama`, the tray app and the global shortcut that drafts answers.",
      movable: false,
      current: "device",
      detail: "Installed on your machine; they read your local sessions.",
      options: [{ place: "device", how: "Always. They need your files and your keychain." }],
    },
    {
      id: "digest",
      name: "Digest drafting",
      what: "Turns a session into key decisions, before you review them.",
      movable: true,
      current: mode === "local" ? "server" : "device",
      detail:
        mode === "local"
          ? "The local server on your machine drafts digests with your small model."
          : "The `pama` binary drafts on your machine; only approved digests are synced.",
      options: [
        { place: "device", how: "`pama login` (remote mode): drafting stays on your machine." },
        { place: "server", how: "Local mode: the sidecar server on your machine drafts." },
      ],
    },
    modelComponent(deps, opts.redact, {
      id: "small",
      name: "Small model",
      what: "Classifier, judge and question suggestions on the server.",
      p: config.small,
      note: "Set it under Models.",
    }),
    modelComponent(deps, opts.redact, {
      id: "chat",
      name: "Answering model",
      what: "Writes answers to Ask Link questions and hotkey drafts.",
      p: chat,
      note: "Set it under Models.",
    }),
    modelComponent(deps, opts.redact, {
      id: "embed",
      name: "Embeddings",
      what: "Finds the digest items that match a question.",
      p: config.embed,
      note: "Changing it re-indexes.",
    }),
    {
      id: "store",
      name: "Digest storage",
      what: "Approved digests, links, inbox and the audit log.",
      movable: true,
      current: home,
      detail: dbDetail[mode],
      options: [
        {
          place: "server",
          how: "Local mode (embedded) or self-host: docker compose, your Postgres.",
        },
        { place: "cloud", how: "pamA Cloud: `pama login --server <url>`." },
      ],
    },
    {
      id: "console",
      name: "Review console",
      what: "This page: review digests, manage links and the inbox.",
      movable: true,
      current: home,
      detail:
        mode === "local"
          ? `Served on ${config.bind}:${config.port}, reachable only from this machine${config.bind === "0.0.0.0" ? " and your LAN" : ""}.`
          : `Served at ${reach.origin}.`,
      options: [
        { place: "server", how: "Local or self-host." },
        { place: "cloud", how: "pamA Cloud." },
      ],
    },
    {
      id: "ask",
      name: "Ask Links",
      what: "The web page other people use to ask your questions.",
      movable: true,
      current: home,
      detail:
        mode === "local"
          ? "Reachable only on this machine or your LAN. Outsiders need a tunnel or a hosted server (docs/local-links.md)."
          : `Public at ${reach.origin}/a/…, protected by PIN or one-time code.`,
      options: [
        { place: "server", how: "Local plus a tunnel, or self-host behind your own domain." },
        { place: "cloud", how: "pamA Cloud: public with no setup." },
      ],
    },
    {
      id: "mail",
      name: "Email (sign-in and notifications)",
      what: "Magic links and one-time codes.",
      movable: false,
      current: config.smtp ? (mode === "cloud" ? "cloud" : "server") : "device",
      detail: config.smtp
        ? "SMTP is configured on the server."
        : mode === "local"
          ? "Not needed in local mode."
          : "SMTP is not configured: sign-in links cannot be sent.",
      options: [{ place: "server", how: "Set SMTP_URL and SMTP_FROM on the server." }],
    },
  ];

  const to = (p: ProviderConfig) =>
    opts.redact && p !== chat ? "the operator's model provider" : hostOf(p);
  const dataFlow: string[] = [];
  for (const [role, p] of [
    ["answering", chat],
    ["small", config.small],
    ["embedding", config.embed],
  ] as const) {
    if (!isLocal(p)) {
      dataFlow.push(
        role === "embedding"
          ? `Text of approved digest items goes to ${to(p)} for embedding.`
          : `Approved digest content and questions go to ${to(p)} (${role} model).`,
      );
    }
  }
  if (mode !== "local") {
    dataFlow.push("Approved digests sync from your machine to this server.");
  }
  if (dataFlow.length === 0) {
    dataFlow.push("Nothing leaves your machine or LAN.");
  }
  dataFlow.push("Raw transcripts never leave the machine that captured them.");

  return {
    mode,
    baseUrl: config.baseUrl,
    db: deps.db.kind,
    strictOffline: config.strictOffline,
    declaredHosts: opts.redact ? [] : config.declaredHosts,
    components,
    dataFlow,
  };
}
