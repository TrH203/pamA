// Layer 3 (Constitution II, FR-013): before an answer is shown, re-scan it with the shared rules,
// check denied topics, and ask a judge model. Any failure — including the judge failing — means
// the answer is refused and can be forwarded to the owner. It is never sent.
import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { loadPrompt, render } from "../llm/prompts.ts";
import type { RuleSet } from "../safety/rules.ts";

export interface GuardResult {
  leak: boolean;
  off_scope: boolean;
  unsupported_claims: boolean;
  rule_hits: string[];
}

export type Judge = (a: {
  answer: string;
  items: GuardItem[];
  denyTopics: string[];
}) => Promise<Omit<GuardResult, "rule_hits">>;

export interface GuardItem {
  id: string;
  text: string;
  rationale?: string | null;
}

export interface GuardOutcome {
  ok: boolean;
  reason?: "guard_failed" | "denied_topic";
  guard: GuardResult;
}

/** Whole-word, case-insensitive match of a denied topic. */
export function mentionsTopic(text: string, topics: string[]): string | undefined {
  const t = text.toLowerCase();
  return topics.find((topic) => {
    const k = topic.trim().toLowerCase();
    if (!k) return false;
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "u").test(t);
  });
}

export async function checkAnswer(a: {
  answer: string;
  items: GuardItem[];
  denyTopics: string[];
  rules: RuleSet;
  judge: Judge;
}): Promise<GuardOutcome> {
  const scan = a.rules.redact(a.answer);
  const rule_hits = Object.keys(scan.counts.by_rule);
  const guard: GuardResult = {
    leak: rule_hits.length > 0,
    off_scope: false,
    unsupported_claims: false,
    rule_hits,
  };
  if (guard.leak) return { ok: false, reason: "guard_failed", guard };
  if (mentionsTopic(a.answer, a.denyTopics))
    return { ok: false, reason: "denied_topic", guard: { ...guard, off_scope: true } };
  try {
    const j = await a.judge({ answer: a.answer, items: a.items, denyTopics: a.denyTopics });
    Object.assign(guard, {
      leak: j.leak,
      off_scope: j.off_scope,
      unsupported_claims: j.unsupported_claims,
    });
  } catch {
    // Fail closed: no verdict, no answer.
    return { ok: false, reason: "guard_failed", guard: { ...guard, leak: true } };
  }
  const ok = !guard.leak && !guard.off_scope && !guard.unsupported_claims;
  return ok ? { ok, guard } : { ok, reason: "guard_failed", guard };
}

const VerdictSchema = z.object({
  leak: z.boolean(),
  off_scope: z.boolean(),
  unsupported_claims: z.boolean(),
});

export function modelJudge(model: LanguageModel): Judge {
  return async ({ answer, items, denyTopics }) => {
    const prompt = loadPrompt("judge");
    const data = items
      .map((i) => `- ${i.text}${i.rationale ? ` (why: ${i.rationale})` : ""}`)
      .join("\n");
    const { output } = await generateText({
      model,
      system: render(prompt, { deny_topics: denyTopics.length ? denyTopics.join(", ") : "(none)" }),
      prompt: `<items>\n${data}\n</items>\n<answer>\n${answer}\n</answer>`,
      output: Output.object({ schema: VerdictSchema }),
      temperature: 0,
    });
    return output;
  };
}
