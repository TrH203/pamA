// HTTP error type and the error body from contracts/http-api.md: { "error": { code, message } }.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { modelHttpError } from "./llm/errors.ts";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function onError(err: Error, c: Context) {
  if (err instanceof HttpError) return c.json(errorBody(err.code, err.message), err.status);
  if (err.name === "ZodError") return c.json(errorBody("invalid_request", err.message), 422);
  const model = modelHttpError(err);
  if (model) {
    console.error(`${model.code}: ${model.message}`, err);
    return c.json(errorBody(model.code, model.message), model.status);
  }
  console.error(err);
  return c.json(errorBody("internal", "internal error"), 500);
}
