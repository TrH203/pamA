// 3–5 example questions per link (FR-010), editable by the owner.
import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { loadPrompt } from "../llm/prompts.ts";
import type { ScopedItem } from "../policy/scoped-repo.ts";
import { itemLine } from "./answer.ts";

const Schema = z.object({ questions: z.array(z.string()) });

export async function suggestQuestions(
  model: LanguageModel,
  items: ScopedItem[],
): Promise<string[]> {
  if (!items.length) return [];
  const { output } = await generateText({
    model,
    system: loadPrompt("suggest-questions").body,
    prompt: `<items>\n${items
      .slice(0, 30)
      .map((it, k) => itemLine(k + 1, it))
      .join("\n")}\n</items>`,
    output: Output.object({ schema: Schema }),
    temperature: 0,
  });
  return [...new Set(output.questions.map((q) => q.trim()).filter(Boolean))]
    .map((q) => q.slice(0, 200))
    .slice(0, 5);
}
