// Answering (research R14): scoped hybrid retrieval → answer prompt (policy, owner instruction,
// items as data, question as data) → cite-or-refuse → Layer 3 guard.
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
): AnswerResult => ({
  status: "refused",
  reason,
  citations: [],
  confidence,
  language,
  guard,
  retrieved,
});

export async function answerQuestion(
  deps: Pick<Deps, "db" | "models" | "rules">,
  input: AnswerInput,
): Promise<AnswerResult> {
  const language = detectLanguage(input.question);
  if (mentionsTopic(input.question, input.denyTopics)) return refuse("denied_topic", language, []);

  const { embedding } = await embed({ model: deps.models.embed, value: input.question });
  const items = await scopedItems(deps.db, input.scope, { embedding, text: input.question, k: 8 });
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
    prompt: `<items>\n${items.map((it, k) => itemLine(k + 1, it)).join("\n")}\n</items>\n<question>\n${input.question}\n</question>`,
    output: Output.object({ schema: OutputSchema }),
    temperature: 0,
  });

  const lang = output.language || language;
  // The model found nothing in scope that answers the question.
  if (output.status === "refused" || !output.answer.trim()) {
    return refuse("out_of_scope", lang, items, null, output.confidence);
  }
  // Cite or escalate: only items that were actually retrieved in scope can be cited.
  const cited = [...new Set(output.citations)]
    .map((n) => items[n - 1])
    .filter((i): i is ScopedItem => i !== undefined);
  if (!cited.length || output.confidence < input.threshold) {
    return refuse("low_confidence", lang, items, null, output.confidence);
  }
  const verdict = await checkAnswer({
    answer: output.answer,
    items: cited,
    denyTopics: input.denyTopics,
    rules: deps.rules,
    judge: modelJudge(deps.models.small),
  });
  if (!verdict.ok)
    return refuse(verdict.reason ?? "guard_failed", lang, items, verdict.guard, output.confidence);
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
