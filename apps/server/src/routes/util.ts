import type { Context } from "hono";
import type { z } from "zod";
import { HttpError } from "../http.ts";

/** Parse and validate a JSON body; 422 with the contract error body on failure. */
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(422, "invalid_request", "body must be JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(422, "invalid_request", r.error.message);
  return r.data;
}
