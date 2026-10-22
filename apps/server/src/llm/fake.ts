// Deterministic models for tests, evals and offline demos (provider "fake").
// The language model answers through a replaceable handler; embeddings are hashed bags of words
// so texts that share words are similar.
import type { EmbeddingModel, LanguageModel } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";

export const FAKE_DIM = 1024;

export interface FakePrompt {
  system: string;
  user: string;
}

export type FakeHandler = (p: FakePrompt) => string;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function fakeEmbedding(text: string, dim = FAKE_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    v[fnv1a(w) % dim] = (v[fnv1a(w) % dim] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

type Part = { type: string; text?: string };
type Msg = { role: string; content: string | Part[] };

function textOf(m: Msg): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

export class FakeModels {
  handler: FakeHandler = () => "{}";
  readonly calls: FakePrompt[] = [];

  readonly language: LanguageModel = new MockLanguageModelV4({
    provider: "fake",
    modelId: "fake",
    doGenerate: async (opts) => {
      const msgs = opts.prompt as unknown as Msg[];
      const p = {
        system: msgs
          .filter((m) => m.role === "system")
          .map(textOf)
          .join("\n"),
        user: msgs
          .filter((m) => m.role !== "system")
          .map(textOf)
          .join("\n"),
      };
      this.calls.push(p);
      return {
        content: [{ type: "text", text: this.handler(p) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  readonly embedding: EmbeddingModel = new MockEmbeddingModelV4({
    provider: "fake",
    modelId: "fake-embed",
    maxEmbeddingsPerCall: 256,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v) => fakeEmbedding(String(v))),
      warnings: [],
    }),
  });
}
