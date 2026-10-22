// Placeholder until the answer pipeline exists (tasks.md, US2: "Wire evals/runner.ts to the real
// answer pipeline"). The runner only reaches this when cases exist.
import type { EvalCase } from "./cases.ts";
import type { EvalAnswer } from "./judge.ts";

export interface Harness {
  ask(c: EvalCase): Promise<EvalAnswer>;
  scopeOf(c: EvalCase): Set<string>;
  close(): Promise<void>;
}

export async function createHarness(_fixturesDir: string): Promise<Harness> {
  throw new Error("eval harness is not wired to the answer pipeline yet");
}
