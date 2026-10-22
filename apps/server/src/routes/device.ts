// Device endpoints used by pama-core. The transcript endpoint exists only on the owner's own
// machine: Layer-1-redacted events must never reach a remote server (Constitution I); servers
// answer 403 (auth/index.ts).
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { digestTranscript } from "../pipeline/digest.ts";
import { TranscriptInputSchema } from "../pipeline/transcript.ts";
import { body } from "./util.ts";

export const deviceRoutes = new Hono<Env>().post("/transcripts/digest", async (c) => {
  const input = await body(c, TranscriptInputSchema);
  return c.json(await digestTranscript(c.get("deps"), input));
});
