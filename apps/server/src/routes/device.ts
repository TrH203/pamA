// Device endpoints used by pama-core. The transcript endpoint exists only on the owner's own
// machine: Layer-1-redacted events must never reach a remote server (Constitution I).
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { digestTranscript } from "../pipeline/digest.ts";
import { TranscriptInputSchema } from "../pipeline/transcript.ts";
import { body } from "./util.ts";

/** Mounted before auth so remote servers always answer 403, whoever asks. */
export const transcriptsGuard = new Hono<Env>().post("/transcripts/digest", async (c, next) => {
  if (c.get("deps").config.mode !== "local") {
    throw new HttpError(403, "local_only", "transcripts are only accepted by the local sidecar");
  }
  await next();
});

export const deviceRoutes = new Hono<Env>().post("/transcripts/digest", async (c) => {
  const input = await body(c, TranscriptInputSchema);
  return c.json(await digestTranscript(c.get("deps"), input));
});
