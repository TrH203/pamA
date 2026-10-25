// Status and compatibility checks for one model role (spec US3, research R4). Every request goes
// through the egress guard, so strict offline mode and the network log apply to checks too.
import { embedMany, generateText } from "ai";
import type { ProviderConfig } from "../config.ts";
import { EMBED_DIM } from "../db/schema/digest.ts";
import { EgressBlockedError, type EgressGuard } from "../net/egress.ts";
import type { FakeModels } from "./fake.ts";
import { embedding, language } from "./providers.ts";

export type Role = "chat" | "small" | "embed";

export interface CheckItem {
  name: "config" | "offline" | "reachable" | "model" | "key" | "json_output" | "dimension";
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface CheckResult {
  role: Role;
  ok: boolean;
  latencyMs: number | null;
  items: CheckItem[];
}

const TIMEOUT_MS = 10_000;

function statusOf(e: unknown): number | undefined {
  const x = e as { statusCode?: number; cause?: { statusCode?: number } } | undefined;
  return x?.statusCode ?? x?.cause?.statusCode;
}

/** Turn a provider error into the check item that names the cause and a fix. */
export function classify(e: unknown): CheckItem {
  if (e instanceof EgressBlockedError) {
    return {
      name: "offline",
      ok: false,
      detail: e.message,
      fix: "declare the host or turn strict offline off",
    };
  }
  const status = statusOf(e);
  const msg = e instanceof Error ? e.message : String(e);
  if (status === 401 || status === 403) {
    return {
      name: "key",
      ok: false,
      detail: "the API key was rejected",
      fix: "set a valid API key",
    };
  }
  if (status === 404 || /not found|does not exist|unknown model/i.test(msg)) {
    return {
      name: "model",
      ok: false,
      detail: "the model was not found at the provider",
      fix: "check the model name (for Ollama: `ollama pull <model>`)",
    };
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|abort|timed out/i.test(msg)) {
    return {
      name: "reachable",
      ok: false,
      detail: "the endpoint is unreachable",
      fix: "check the endpoint URL and that the service is running",
    };
  }
  return { name: "reachable", ok: false, detail: msg.slice(0, 200) };
}

/** Static checks that need no network: required fields. */
export function staticItems(role: Role, p: ProviderConfig): CheckItem[] {
  const items: CheckItem[] = [];
  if (p.provider === "openai-compatible" && !p.baseUrl) {
    items.push({
      name: "config",
      ok: false,
      detail: "an OpenAI-compatible provider needs an endpoint URL",
      fix: "set the endpoint (base URL)",
    });
  }
  if (p.provider === "anthropic" && !p.apiKey) {
    items.push({
      name: "key",
      ok: false,
      detail: "no API key is set",
      fix: "set an API key for Anthropic",
    });
  }
  if (p.provider === "openrouter" && !p.apiKey) {
    items.push({
      name: "key",
      ok: false,
      detail: "no API key is set",
      fix: "create a key at openrouter.ai/keys and set it",
    });
  }
  if (role === "embed" && p.provider === "anthropic") {
    items.push({
      name: "config",
      ok: false,
      detail: "Anthropic has no embedding API",
      fix: "use ollama (bge-m3) or an openai-compatible endpoint",
    });
  }
  return items;
}

export async function checkProvider(
  role: Role,
  p: ProviderConfig,
  guard: EgressGuard,
  fake?: FakeModels,
): Promise<CheckResult> {
  const items = staticItems(role, p);
  if (items.length) return { role, ok: false, latencyMs: null, items };
  if (p.provider === "fake") {
    return {
      role,
      ok: true,
      latencyMs: 0,
      items: [{ name: "reachable", ok: true, detail: "built-in test model" }],
    };
  }
  const started = Date.now();
  const abortSignal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    if (role === "embed") {
      const { embeddings } = await embedMany({
        model: embedding(p, guard, fake),
        values: ["pamA check"],
        maxRetries: 0,
        abortSignal,
      });
      const dim = embeddings[0]?.length ?? 0;
      const ok = dim === EMBED_DIM;
      return {
        role,
        ok,
        latencyMs: Date.now() - started,
        items: [
          { name: "reachable", ok: true, detail: "the endpoint answered" },
          { name: "model", ok: true, detail: `${p.model} produced a ${dim}-dimension vector` },
          {
            name: "dimension",
            ok,
            detail: ok
              ? `vector size ${dim} matches the stored data`
              : `vector size ${dim} does not match the ${EMBED_DIM} the database stores`,
            fix: ok ? undefined : `choose a ${EMBED_DIM}-dimension model such as bge-m3`,
          },
        ],
      };
    }
    const { text } = await generateText({
      model: language(p, guard, fake, `llm.check.${role}`),
      prompt: 'Reply with exactly this JSON and nothing else: {"ok":true}',
      maxRetries: 0,
      abortSignal,
    });
    let json = false;
    try {
      json = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "").ok === true;
    } catch {
      json = false;
    }
    return {
      role,
      ok: json,
      latencyMs: Date.now() - started,
      items: [
        { name: "reachable", ok: true, detail: "the endpoint answered" },
        { name: "model", ok: true, detail: `${p.model} responded` },
        {
          name: "json_output",
          ok: json,
          detail: json
            ? "the model follows JSON output instructions"
            : "the model did not return valid JSON when asked",
          fix: json ? undefined : "pick a more capable model; digests and answers need JSON output",
        },
      ],
    };
  } catch (e) {
    return { role, ok: false, latencyMs: Date.now() - started, items: [classify(e)] };
  }
}
