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
  if (p.system.includes("# pamA answer")) return JSON.stringify(heuristicAnswer(p.user));
  if (p.system.includes("# pamA judge")) return JSON.stringify(heuristicJudge(p.user));
  if (p.system.includes("# pamA suggest-questions"))
    return JSON.stringify(heuristicSuggest(p.user));
  return "{}";
}

// --- Ask Link heuristics -------------------------------------------------------------------

const STOP = new Set(
  "the a an and or but for nor of to in on at by with from as is are was were be been being do does did done have has had will would should can could may might must shall this that these those it its we you they he she them our your their what which who whom whose when where why how not no yes about into over than then there here also just only any all some each other such same very more most much many few own please tell me us".split(
    " ",
  ),
);

export function contentWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => w.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : ""))),
  );
}

export function detectLanguage(text: string): string {
  if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) return "vi";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[가-힯]/.test(text)) return "ko";
  return "en";
}

function block(user: string, tag: string): string {
  return new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(user)?.[1] ?? "";
}

function parseItems(user: string): { n: number; text: string }[] {
  return [...block(user, "items").matchAll(/^\[(\d+)\] ([^\n]*(?:\n {4}[^\n]*)*)/gm)].map((m) => ({
    n: Number(m[1]),
    text: m[2] as string,
  }));
}

export function heuristicAnswer(user: string) {
  const question = block(user, "question");
  const language = detectLanguage(question);
  const q = contentWords(question);
  const scored = parseItems(user)
    .map((i) => ({ ...i, overlap: [...contentWords(i.text)].filter((w) => q.has(w)).length }))
    .filter((i) => i.overlap >= 2)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 2);
  if (!scored.length)
    return { status: "refused", answer: "", citations: [], confidence: 0.1, language };
  return {
    status: "answered",
    answer: scored
      .map((i) => i.text.replace(/^\((\w+)\) /, "").replace(/\n {4}why: /, " Reason: "))
      .join(" "),
    citations: scored.map((i) => i.n),
    confidence: Math.min(0.95, 0.6 + 0.1 * (scored[0]?.overlap ?? 0)),
    language,
  };
}

export function heuristicJudge(user: string) {
  const answer = block(user, "answer");
  return {
    leak: /\[(SECRET|PII|DROPPED):/.test(answer),
    off_scope: false,
    unsupported_claims: false,
  };
}

export function heuristicSuggest(user: string) {
  const questions = parseItems(user)
    .filter((i) => i.text.startsWith("(decision)"))
    .slice(0, 4)
    .map((i) => {
      const what =
        i.text
          .replace(/^\(decision\) /, "")
          .split("\n")[0]
          ?.replace(/\.$/, "") ?? "";
      return `Why was it decided that ${what.charAt(0).toLowerCase()}${what.slice(1)}?`.slice(
        0,
        200,
      );
    });
  const goals = parseItems(user).filter((i) => i.text.startsWith("(goal)"));
  if (goals[0])
    questions.push(
      `What was the goal of: ${goals[0].text.replace(/^\(goal\) /, "").slice(0, 120)}`,
    );
  while (questions.length < 3)
    questions.push(
      ["What was decided?", "What is still open?", "What changed?"][questions.length] as string,
    );
  return { questions: questions.slice(0, 5) };
}
