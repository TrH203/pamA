// Model provider registry (research R7). Every provider's HTTP traffic goes through the egress
// guard, so strict offline mode and the network log cover model calls too.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  defaultSettingsMiddleware,
  type EmbeddingModel,
  type LanguageModel,
  wrapLanguageModel,
} from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import type { Config, ProviderConfig } from "../config.ts";
import type { EgressGuard } from "../net/egress.ts";
import { FakeModels } from "./fake.ts";

export interface Models {
  /** Answers and drafts. */
  chat: LanguageModel;
  /** Digest, classifier, judge, suggestions. */
  small: LanguageModel;
  embed: EmbeddingModel;
  /** True when every model runs on the owner's machine or LAN (stricter answer threshold). */
  local: boolean;
  /** Present when the provider is "fake" (tests, evals). */
  fake?: FakeModels;
}

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";
export const OPENROUTER_DEFAULT = "https://openrouter.ai/api/v1";
/** OpenRouter's optional app attribution headers. */
const OPENROUTER_HEADERS = { "HTTP-Referer": "https://github.com/TrH203/pamA", "X-Title": "pamA" };

export function isLocal(p: ProviderConfig): boolean {
  if (p.provider === "fake" || p.provider === "ollama") return true;
  if (p.provider === "anthropic" || p.provider === "openrouter") return false;
  const host = p.baseUrl ? new URL(p.baseUrl).hostname : "";
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$|\.lan$/.test(host);
}

export function language(
  p: ProviderConfig,
  guard: EgressGuard,
  fake: FakeModels | undefined,
  purpose: string,
): LanguageModel {
  const fetch = guard.fetchFor(purpose);
  switch (p.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: p.apiKey, baseURL: p.baseUrl, fetch })(p.model);
    case "openai-compatible":
      if (!p.baseUrl) throw new Error("openai-compatible provider needs a base URL");
      return wrapLanguageModel({
        model: createOpenAICompatible({
          name: "openai-compatible",
          baseURL: p.baseUrl,
          apiKey: p.apiKey,
          fetch,
          // Without this the schema is never sent (only `json_object`) and the model guesses the shape.
          supportsStructuredOutputs: new URL(p.baseUrl).hostname === "api.openai.com",
        }).chatModel(p.model),
        // Our zod schemas use optional/default fields, which OpenAI's strict mode rejects.
        middleware: defaultSettingsMiddleware({
          settings: { providerOptions: { openaiCompatible: { strictJsonSchema: false } } },
        }),
      });
    case "openrouter":
      // OpenRouter speaks the OpenAI chat protocol; many of its models lack json_schema support,
      // so structured output stays on `json_object` like other compatible endpoints.
      return wrapLanguageModel({
        model: createOpenAICompatible({
          name: "openrouter",
          baseURL: p.baseUrl ?? OPENROUTER_DEFAULT,
          apiKey: p.apiKey,
          headers: OPENROUTER_HEADERS,
          fetch,
        }).chatModel(p.model),
        middleware: defaultSettingsMiddleware({
          settings: { providerOptions: { openaiCompatible: { strictJsonSchema: false } } },
        }),
      });
    case "ollama":
      return createOllama({ baseURL: `${p.baseUrl ?? OLLAMA_DEFAULT}/api`, fetch })(p.model);
    case "fake":
      if (!fake) throw new Error("fake models not initialized");
      return fake.language;
  }
}

export function embedding(
  p: ProviderConfig,
  guard: EgressGuard,
  fake: FakeModels | undefined,
): EmbeddingModel {
  const fetch = guard.fetchFor("llm.embed");
  switch (p.provider) {
    case "openai-compatible":
      if (!p.baseUrl) throw new Error("openai-compatible provider needs a base URL");
      return createOpenAICompatible({
        name: "openai-compatible",
        baseURL: p.baseUrl,
        apiKey: p.apiKey,
        fetch,
      }).embeddingModel(p.model);
    case "openrouter":
      return createOpenAICompatible({
        name: "openrouter",
        baseURL: p.baseUrl ?? OPENROUTER_DEFAULT,
        apiKey: p.apiKey,
        headers: OPENROUTER_HEADERS,
        fetch,
      }).embeddingModel(p.model);
    case "ollama":
      return createOllama({
        baseURL: `${p.baseUrl ?? OLLAMA_DEFAULT}/api`,
        fetch,
      }).textEmbeddingModel(p.model);
    case "fake":
      if (!fake) throw new Error("fake models not initialized");
      return fake.embedding;
    case "anthropic":
      throw new Error("Anthropic has no embedding API; use ollama (bge-m3) or openai-compatible");
  }
}

export function createModels(
  config: Pick<Config, "chat" | "small" | "embed">,
  guard: EgressGuard,
): Models {
  const usesFake = [config.chat, config.small, config.embed].some((p) => p.provider === "fake");
  const fake = usesFake ? new FakeModels() : undefined;
  return {
    chat: language(config.chat, guard, fake, "llm.chat"),
    small: language(config.small, guard, fake, "llm.small"),
    embed: embedding(config.embed, guard, fake),
    local: [config.chat, config.small, config.embed].every(isLocal),
    fake,
  };
}
