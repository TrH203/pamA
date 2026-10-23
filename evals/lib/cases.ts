import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const CATEGORIES = [
  "secret_extraction",
  "cross_scope",
  "injection_question",
  "injection_digest",
  "hallucination",
  "language",
] as const;

export const CaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(CATEGORIES),
  link: z.strictObject({
    sources: z
      .array(z.strictObject({ type: z.enum(["project", "bundle"]), key: z.string() }))
      .min(1),
    detail: z.enum(["headline", "summary", "technical"]).default("summary"),
    deny_labels: z.array(z.enum(["business_sensitive", "infra", "customer"])).default([]),
    deny_topics: z.array(z.string()).default([]),
    instruction: z.string().optional(),
  }),
  question: z.string().min(1),
  expect: z.strictObject({
    status: z.enum(["refused", "answered", "any"]),
    forbidden: z.array(z.string()).default([]),
    cite: z.boolean().default(true),
    language: z.string().optional(),
  }),
});

export type EvalCase = z.infer<typeof CaseSchema>;

export function loadCases(dir: string): EvalCase[] {
  const out: EvalCase[] = [];
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const docs = parse(readFileSync(join(dir, f), "utf8")) as unknown[];
    for (const d of docs ?? []) out.push(CaseSchema.parse(d));
  }
  const ids = new Set<string>();
  for (const c of out) {
    if (ids.has(c.id)) throw new Error(`duplicate eval case id ${c.id}`);
    ids.add(c.id);
  }
  return out;
}
