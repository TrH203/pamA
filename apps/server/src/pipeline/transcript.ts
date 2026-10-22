// Input of POST /v1/transcripts/digest: Layer-1-redacted, normalized events from the device.
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentSchema } from "../schema/digest.ts";

export const EventSchema = z.object({
  kind: z.enum(["user", "assistant", "tool_call", "tool_result"]),
  text: z.string().max(20_000),
  tool: z.string().max(64).optional(),
  path: z.string().max(1_000).optional(),
  command: z.string().max(4_000).optional(),
  call_id: z.string().max(128).optional(),
  at: z.string().max(64).optional(),
});

export const RedactionsSchema = z.object({
  secret: z.int().min(0),
  pii: z.int().min(0),
  by_rule: z.record(z.string(), z.int().min(0)).optional(),
});
export type Redactions = z.infer<typeof RedactionsSchema>;

export const TranscriptInputSchema = z.strictObject({
  agent: AgentSchema,
  agent_session_id: z.string().min(1).max(128),
  /** Normalized remote or path hash; the device never sends absolute paths. */
  project_key: z.string().min(1).max(256),
  project_name: z.string().min(1).max(200).optional(),
  bundle_key: z.string().max(256).optional(),
  agent_version: z.string().max(64).optional(),
  started_at: z.iso.datetime({ offset: true }).optional(),
  ended_at: z.iso.datetime({ offset: true }),
  git: z
    .strictObject({
      branch: z.string().max(256).optional(),
      commits: z
        .array(z.string().regex(/^[0-9a-f]{7,40}$/))
        .max(50)
        .optional(),
    })
    .optional(),
  events: z.array(EventSchema).max(20_000),
  redactions: RedactionsSchema,
});
export type TranscriptInput = z.infer<typeof TranscriptInputSchema>;

/** Budget for the transcript sent to the digest model (head + tail, decisions cluster late). */
export const MAX_TRANSCRIPT_CHARS = 48_000;
const HEAD = 12_000;

export function formatTranscript(events: TranscriptInput["events"]): string {
  const lines = events.map((e) => {
    switch (e.kind) {
      case "user":
        return `[user] ${e.text}`;
      case "assistant":
        return `[assistant] ${e.text}`;
      case "tool_call":
        return `[tool ${e.tool ?? "?"}] ${e.text}`;
      case "tool_result":
        return `[result ${e.tool ?? "?"}] ${e.text}`;
    }
  });
  const full = lines.join("\n");
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full;
  const tail = MAX_TRANSCRIPT_CHARS - HEAD;
  return `${full.slice(0, HEAD)}\n[… middle of the session omitted …]\n${full.slice(-tail)}`;
}

export function inputHash(input: TranscriptInput): string {
  return createHash("sha256").update(JSON.stringify(input.events)).digest("hex");
}

export function mergeRedactions(...all: Redactions[]): Redactions {
  const out: Redactions = { secret: 0, pii: 0, by_rule: {} };
  for (const r of all) {
    out.secret += r.secret;
    out.pii += r.pii;
    for (const [k, v] of Object.entries(r.by_rule ?? {})) {
      (out.by_rule as Record<string, number>)[k] = (out.by_rule?.[k] ?? 0) + v;
    }
  }
  return out;
}
