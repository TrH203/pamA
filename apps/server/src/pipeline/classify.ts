// Layer 2 at ingest (Constitution II): deterministic rules (secrets + PII) over every string of
// the digest, then an LLM classifier that labels items business_sensitive / infra / customer.
import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { loadPrompt } from "../llm/prompts.ts";
import type { RuleSet } from "../safety/rules.ts";
import { SensitivityLabelSchema } from "../schema/digest.ts";
import type { DraftItem, LabelMap } from "./items.ts";
import type { Redactions } from "./transcript.ts";

/** Redact every string inside a JSON value; returns the cleaned value and the counts. */
export function sanitizeDeep<T>(value: T, rules: RuleSet): { value: T; counts: Redactions } {
  const counts: Redactions = { secret: 0, pii: 0, by_rule: {} };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = rules.redact(v);
      counts.secret += r.counts.secret;
      counts.pii += r.counts.pii;
      for (const [k, n] of Object.entries(r.counts.by_rule)) {
        (counts.by_rule as Record<string, number>)[k] = (counts.by_rule?.[k] ?? 0) + n;
      }
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value) as T, counts };
}

const ClassifySchema = z.object({
  items: z.array(z.object({ id: z.string(), labels: z.array(SensitivityLabelSchema) })),
});

export async function classifyItems(model: LanguageModel, items: DraftItem[]): Promise<LabelMap> {
  if (!items.length) return {};
  const prompt = loadPrompt("classify");
  const data = items
    .map((i) => `id: ${i.local}\ntext: ${i.text}${i.rationale ? `\nwhy: ${i.rationale}` : ""}`)
    .join("\n---\n");
  const { output } = await generateText({
    model,
    system: prompt.body,
    prompt: `<items>\n${data}\n</items>`,
    output: Output.object({ schema: ClassifySchema }),
    temperature: 0,
  });
  const known = new Set(items.map((i) => i.local));
  const out: LabelMap = {};
  for (const x of output.items) {
    if (known.has(x.id)) out[x.id] = [...new Set(x.labels)];
  }
  return out;
}
