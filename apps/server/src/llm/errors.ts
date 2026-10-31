// Readable model errors. Each real model is wrapped so a failing call carries the role, provider
// and model id, and gets a time limit. The HTTP error handler turns the tagged error into a coded
// 502/503/504 instead of a bare "internal error".
import type { EmbeddingModel, LanguageModel } from "ai";
import { HttpError } from "../http.ts";

export type Role = "chat" | "small" | "embed";

export interface ModelTag {
  role: Role;
  provider: string;
  model: string;
}

const TAG = Symbol.for("pama.modelTag");

/** Time limits per call. The device waits up to 180 s for a whole digest request. */
export const TIMEOUT_MS: Record<Role, number> = { chat: 90_000, small: 90_000, embed: 60_000 };

function withTimeout(options: unknown, ms: number): unknown {
  if (!options || typeof options !== "object") return options;
  const o = options as { abortSignal?: AbortSignal };
  const timer = AbortSignal.timeout(ms);
  return { ...o, abortSignal: o.abortSignal ? AbortSignal.any([o.abortSignal, timer]) : timer };
}

function tagError(err: unknown, tag: ModelTag): unknown {
  if (err && typeof err === "object" && !(TAG in err)) {
    try {
      Object.defineProperty(err, TAG, { value: tag, enumerable: false });
    } catch {
      // frozen error objects keep their original shape
    }
  }
  return err;
}

const CALLS = new Set(["doGenerate", "doStream", "doEmbed"]);

/** Wrap a model so its calls time out and its errors carry `tag`. Strings (gateway ids) pass through. */
export function tagModel<M extends LanguageModel | EmbeddingModel>(model: M, tag: ModelTag): M {
  if (typeof model !== "object" || model === null) return model;
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !CALLS.has(prop) || typeof value !== "function") return value;
      return async (options: unknown) => {
        try {
          return await value.call(target, withTimeout(options, TIMEOUT_MS[tag.role]));
        } catch (err) {
          throw tagError(err, tag);
        }
      };
    },
  }) as M;
}

interface ErrLike {
  name?: string;
  message?: string;
  statusCode?: number;
  code?: string;
  cause?: unknown;
  lastError?: unknown;
  errors?: unknown[];
  [TAG]?: ModelTag;
}

/** Walk RetryError.lastError / errors / cause chains. */
function chain(err: unknown): ErrLike[] {
  const out: ErrLike[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length && out.length < 12) {
    const e = queue.shift();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const x = e as ErrLike;
    out.push(x);
    queue.push(x.lastError, x.cause, ...(Array.isArray(x.errors) ? x.errors.slice(-1) : []));
  }
  return out;
}

const UNREACHABLE =
  /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|fetch failed|Cannot connect/i;

const LABEL: Record<Role, string> = {
  chat: "Chat model",
  small: "Small model",
  embed: "Embedding model",
};

/** Map a tagged model failure to an HttpError, or null when `err` is not a model failure. */
export function modelHttpError(err: unknown): HttpError | null {
  const links = chain(err);
  const tag = links.find((e) => e[TAG])?.[TAG];
  if (!tag) return null;
  const who = `${LABEL[tag.role]} (${tag.provider} ${tag.model})`;
  const fix = `Check it with \`pama model check ${tag.role}\` or change it with \`pama model set ${tag.role}\`.`;
  const status = links.find((e) => typeof e.statusCode === "number")?.statusCode;
  const timedOut = links.some((e) => e.name === "TimeoutError" || e.name === "AbortError");
  const text = links.map((e) => `${e.code ?? ""} ${e.message ?? ""}`).join(" ");

  if (timedOut)
    return new HttpError(
      504,
      "model_timeout",
      `${who} did not answer within ${TIMEOUT_MS[tag.role] / 1000} s. ${fix}`,
    );
  if (status === 401 || status === 403)
    return new HttpError(
      502,
      "provider_auth",
      `${who} rejected the API key (HTTP ${status}). Save a valid key: \`pama model set ${tag.role} --key-stdin\`.`,
    );
  if (status === 429)
    return new HttpError(
      503,
      "rate_limited",
      `${who} is rate limited (HTTP 429). pamA will retry.`,
    );
  if (status === undefined && UNREACHABLE.test(text)) {
    const hint =
      tag.provider === "ollama" ? " Start Ollama (`ollama serve`) or pick another provider." : "";
    return new HttpError(502, "provider_unreachable", `${who} is unreachable.${hint} ${fix}`);
  }
  const detail = links.find((e) => e.message)?.message ?? "unknown error";
  return new HttpError(
    502,
    "provider_error",
    `${who} failed${status ? ` (HTTP ${status})` : ""}: ${detail.slice(0, 300)}`,
  );
}
