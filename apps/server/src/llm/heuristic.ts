// Default behaviour of the "fake" provider: a deterministic, extractive digester and keyword
// classifier. It lets pamA run end to end with no model at all (tests, demos, CI), and it never
// invents content: every sentence comes from the transcript.
import type { FakePrompt } from "./fake.ts";

const DECISION =
  /\b(decision|decided|decide|we will|will not|won't|chose|choose|instead of|rather than|rejected|keep|use)\b/i;
const REJECTED = /\b(rejected|instead of|rather than|considered)\b[:\s]*(.*)/i;
const OPEN = /\b(open item|todo|follow[- ]up|confirm|next step)\b[:\s]*(.*)/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function lines(user: string, tag: string): string[] {
  return user
    .split("\n")
    .filter((l) => l.startsWith(`[${tag}] `))
    .map((l) => l.slice(tag.length + 3));
}

export function heuristicDigest(user: string) {
  const users = lines(user, "user");
  const assistants = lines(user, "assistant");
  const said = assistants.flatMap(sentences);
  const decisions = said
    .filter((s) => DECISION.test(s) && !/^\[/.test(s))
    .slice(0, 5)
    .map((s) => {
      const [what, ...why] = s.split(/\s+because\s+/i);
      const alt = REJECTED.exec(s)?.[2];
      return {
        what: (what ?? s).replace(/^decision:\s*/i, "").trim(),
        why: why.join(" because ").trim(),
        alternatives: alt ? [alt.trim()] : [],
      };
    });
  const modules = [
    ...new Set(
      [...user.matchAll(/(?:^|[\s/])(?:src|lib|app|apps|packages)\/([a-z0-9_-]+)/gim)].map(
        (m) => m[1] as string,
      ),
    ),
  ].slice(0, 10);
  return {
    goal: (users[0] ?? "Session without a stated goal.").slice(0, 400),
    decisions,
    outcome: (assistants.at(-1) ?? "").slice(0, 400),
    open_items: said
      .map((s) => OPEN.exec(s)?.[2]?.trim())
      .filter((s): s is string => Boolean(s))
      .slice(0, 5),
    modules,
  };
}

const LABELS: [string, RegExp][] = [
  ["infra", /\b(server|database|db|deploy|infra|host|cluster|key|token|credential|vpn|aws|gcp)\b/i],
  [
    "business_sensitive",
    /\b(price|pricing|revenue|margin|contract|partner|legal|incident|salary)\b/i,
  ],
  ["customer", /\b(customer|client|user data|account|complaint|khách)\b/i],
];

export function heuristicClassify(user: string) {
  const items = [...user.matchAll(/^id: (\S+)\ntext: (.*)$/gm)].map((m) => ({
    id: m[1] as string,
    labels: LABELS.filter(([, re]) => re.test(m[2] as string)).map(([l]) => l),
  }));
  return { items };
}

export function heuristicHandler(p: FakePrompt): string {
  if (p.system.includes("# pamA digest")) return JSON.stringify(heuristicDigest(p.user));
  if (p.system.includes("# pamA classify")) return JSON.stringify(heuristicClassify(p.user));
  return "{}";
}
