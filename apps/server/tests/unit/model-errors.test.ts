// Model failures become coded, readable HTTP errors that name the role, provider and model.
import { APICallError, type EmbeddingModel, embedMany } from "ai";
import { describe, expect, it } from "vitest";
import { modelHttpError, TIMEOUT_MS, tagModel } from "../../src/llm/errors.ts";

function embedModel(doEmbed: (o: { abortSignal?: AbortSignal }) => Promise<unknown>) {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "bge-m3",
    maxEmbeddingsPerCall: 10,
    supportsParallelCalls: true,
    doEmbed,
  } as unknown as EmbeddingModel;
}

const tag = { role: "embed", provider: "ollama", model: "bge-m3" } as const;

async function failure(model: EmbeddingModel) {
  try {
    await embedMany({ model: tagModel(model, tag), values: ["x"], maxRetries: 0 });
  } catch (err) {
    return modelHttpError(err);
  }
  throw new Error("expected a failure");
}

describe("model errors", () => {
  it("names an unreachable Ollama embed model", async () => {
    const err = await failure(
      embedModel(async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }),
    );
    expect(err?.code).toBe("provider_unreachable");
    expect(err?.status).toBe(502);
    expect(err?.message).toContain("Embedding model (ollama bge-m3)");
    expect(err?.message).toContain("ollama serve");
  });

  it("reports a rejected key", async () => {
    const err = await failure(
      embedModel(async () => {
        throw new APICallError({
          message: "Unauthorized",
          url: "https://x",
          requestBodyValues: {},
          statusCode: 401,
        });
      }),
    );
    expect(err?.code).toBe("provider_auth");
  });

  it("times out a hanging call", async () => {
    const saved = TIMEOUT_MS.embed;
    TIMEOUT_MS.embed = 50;
    try {
      const err = await failure(
        embedModel(
          (o) =>
            new Promise((_, reject) =>
              o.abortSignal?.addEventListener("abort", () => reject(o.abortSignal?.reason)),
            ),
        ),
      );
      expect(err?.code).toBe("model_timeout");
    } finally {
      TIMEOUT_MS.embed = saved;
    }
  });

  it("ignores errors that are not model calls", () => {
    expect(modelHttpError(new Error("boom"))).toBeNull();
  });
});
