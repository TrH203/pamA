// Spec 004: the device drafts digests in Rust (pama_core::draft) for remote mode. Both sides must
// format the transcript and shape the model's draft identically (shared fixture).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DraftSchema, shapeDraft } from "../../src/pipeline/digest.ts";
import { formatTranscript, TranscriptInputSchema } from "../../src/pipeline/transcript.ts";

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../packages/types/fixtures/draft/basic.json"),
    "utf8",
  ),
);

describe("draft parity with the device", () => {
  it("formats the transcript like the fixture", () => {
    const input = TranscriptInputSchema.parse(fixture.input);
    expect(formatTranscript(input.events)).toBe(fixture.prompt);
  });

  it("shapes the model's draft like the fixture", () => {
    const input = TranscriptInputSchema.parse(fixture.input);
    const out = shapeDraft(input, DraftSchema.parse(fixture.reply), { secret: 0, pii: 0 });
    expect(out).toEqual(fixture.expected);
  });
});
