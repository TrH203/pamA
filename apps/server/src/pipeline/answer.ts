// Answering (research R14): scoped hybrid retrieval → answer prompt (policy, owner instruction,
// items as data, question as data) → cite-or-refuse → Layer 3 guard.
// Multi-turn (spec 008b): earlier turns of the same conversation are context only. They are
// passed as data, never widen the scope (retrieval still runs inside `scope`), never become
// citable, and the Layer 3 guard checks every answer as before.
import { embed, generateText, Output } from "ai";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { detectLanguage } from "../llm/heuristic.ts";
import { loadPrompt, render } from "../llm/prompts.ts";
import { type Scope, type ScopedItem, scopedItems } from "../policy/scoped-repo.ts";
import { checkAnswer, type GuardResult, mentionsTopic, modelJudge } from "./guard.ts";

export type RefusalReason = "out_of_scope" | "low_confidence" | "denied_topic" | "guard_failed";

export interface Citation {
  item_id: string;
  digest_id: string;
  digest_version: number;
  label: string;
}

export interface AnswerResult {
  status: "answered" | "refused";
  reason?: RefusalReason;
  answer?: string;
  citations: Citation[];
  confidence: number;
  language: string;
  guard: GuardResult | null;
  /** Items that were in scope and retrieved (for drafting UIs). */
  retrieved: ScopedItem[];
  /** On a refusal, the answer the model wrote before it was held back. Owner-only: it is the
   * suggested reply in the inbox and never reaches a visitor. */
  draft?: string;
}

export interface AnswerInput {
  question: string;
  scope: Scope;
  detail: "headline" | "summary" | "technical";
  instruction: string | null;
  denyTopics: string[];
  ownerName: string;
  threshold: number;
  /** Ask for a shorter answer (hotkey "Shorter"). */
  shorter?: boolean;
  /** Earlier turns of the same conversation, oldest first (see `historyBlock`). */
  history?: PriorTurn[];
}

/** One earlier turn as the asker saw it: their question and the answer shown (null if none). */
export interface PriorTurn {
  question: string;
  answer: string | null;
}

/** At most this many earlier turns are given to the model (decision 9.4). */
export const MAX_PRIOR_TURNS = 6;
/** Rough token cap for the history block (~4 characters per token). */
export const HISTORY_TOKEN_BUDGET = 1500;
const TURN_CHARS = 1200;

/** Tags of the prompt's data blocks; text from a turn must not open or close one. */
const TAGS = /<\s*\/?\s*(history|turn|items|question|answer)\b[^>]*>/gi;
const neutral = (s: string) => s.replace(TAGS, "[$1]");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * The history block for the prompt: the last MAX_PRIOR_TURNS turns, turns touching a denied topic
 * dropped, each clipped, oldest turns dropped until the block fits the token budget. Returns ""
 * when there is nothing to send.
 */
export function historyBlock(turns: PriorTurn[] = [], denyTopics: string[] = []): string {
  const kept = turns
    .filter((t) => !mentionsTopic(`${t.question}\n${t.answer ?? ""}`, denyTopics))
    .slice(-MAX_PRIOR_TURNS)
    .map(
      (t) =>
        `<turn>\nasker: ${clip(neutral(t.question), TURN_CHARS)}\nanswer: ${
          t.answer ? clip(neutral(t.answer), TURN_CHARS) : "(not answered)"
        }\n</turn>`,
    );
  while (kept.length && kept.join("\n").length > HISTORY_TOKEN_BUDGET * 4) kept.shift();
  return kept.length ? `<history>\n${kept.join("\n")}\n</history>\n` : "";
}

/** A question this short may lean on the previous one ("why?", "and the fee?"). */
export const FOLLOW_UP_MAX_WORDS = 8;

/**
 * The text retrieval searches with. The current question drives it; only a short follow-up
 * borrows the previous question (the last earlier turn that touches no denied topic, clipped), so
 * an earlier topic cannot pull in items for a question that stands on its own. Retrieval still
 * runs inside the link's scope, so this only ranks in-scope items differently.
 */
export function retrievalQuery(
  question: string,
  turns: PriorTurn[] = [],
  denyTopics: string[] = [],
): string {
  if (question.trim().split(/\s+/).length > FOLLOW_UP_MAX_WORDS) return question;
  const previous = turns.findLast(
    (t) => !mentionsTopic(`${t.question}\n${t.answer ?? ""}`, denyTopics),
  )?.question;
  return previous ? `${question}\n${clip(previous, 300)}` : question;
}

const OutputSchema = z.object({
  status: z.enum(["answered", "refused"]),
  answer: z.string(),
  citations: z.array(z.int()),
  confidence: z.number().min(0).max(1),
  language: z.string().optional(),
});

export function itemLine(n: number, i: ScopedItem): string {
  const parts = [`[${n}] (${i.kind}) ${i.text}`];
  if (i.rationale) parts.push(`    why: ${i.rationale}`);
  if (i.alternatives.length) parts.push(`    rejected: ${i.alternatives.join("; ")}`);
  return parts.join("\n");
}

const refuse = (
  reason: RefusalReason,
  language: string,
  retrieved: ScopedItem[],
  guard: GuardResult | null = null,
  confidence = 0,
  draft?: string,
): AnswerResult => ({
  status: "refused",
  reason,
  citations: [],
  confidence,
  language,
  guard,
  retrieved,
  ...(draft?.trim() ? { draft: draft.trim() } : {}),
});

export async function answerQuestion(
  deps: Pick<Deps, "db" | "models" | "rules">,
  input: AnswerInput,
): Promise<AnswerResult> {
  const language = detectLanguage(input.question);
  if (mentionsTopic(input.question, input.denyTopics)) return refuse("denied_topic", language, []);

  const history = historyBlock(input.history, input.denyTopics);
  const lookup = retrievalQuery(input.question, input.history, input.denyTopics);
  const { embedding } = await embed({ model: deps.models.embed, value: lookup });
  const items = await scopedItems(deps.db, input.scope, { embedding, text: lookup, k: 8 });
  if (!items.length) return refuse("out_of_scope", language, items);

  const prompt = loadPrompt("answer");
  const system = render(prompt, {
    owner: input.ownerName,
    deny_topics: input.denyTopics.length ? input.denyTopics.join(", ") : "(none)",
    language,
    detail: input.shorter ? "headline" : input.detail,
    instruction: input.instruction?.trim() || "(none)",
  });
  const { output } = await generateText({
    model: deps.models.chat,
    system,
    prompt: `${history}<items>\n${items.map((it, k) => itemLine(k + 1, it)).join("\n")}\n</items>\n<question>\n${neutral(input.question)}\n</question>`,
    output: Output.object({ schema: OutputSchema }),
    temperature: 0,
  });

  const lang = output.language || language;
  // The model found nothing in scope that answers the question.
  if (output.status === "refused" || !output.answer.trim()) {
    return refuse("out_of_scope", lang, items, null, output.confidence, output.answer);
  }
  // Cite or escalate: only items that were actually retrieved in scope can be cited.
  const cited = [...new Set(output.citations)]
    .map((n) => items[n - 1])
    .filter((i): i is ScopedItem => i !== undefined);
  if (!cited.length || output.confidence < input.threshold) {
    return refuse("low_confidence", lang, items, null, output.confidence, output.answer);
  }
  const verdict = await checkAnswer({
    answer: output.answer,
    items: cited,
    denyTopics: input.denyTopics,
    rules: deps.rules,
    judge: modelJudge(deps.models.small),
  });
  if (!verdict.ok)
    return refuse(
      verdict.reason ?? "guard_failed",
      lang,
      items,
      verdict.guard,
      output.confidence,
      output.answer,
    );
  return {
    status: "answered",
    answer: output.answer,
    citations: cited.map((i) => ({
      item_id: i.id,
      digest_id: i.digest_id,
      digest_version: i.digest_version,
      label: `${i.kind.replace("_", " ")} · ${i.bundle}`,
    })),
    confidence: output.confidence,
    language: lang,
    guard: verdict.guard,
    retrieved: items,
  };
}
