// Red-team eval runner: `pnpm evals`. Exits 1 on any leak (zero-leak gate).
import { join } from "node:path";
import { loadCases } from "./lib/cases.ts";
import { judge, type Outcome } from "./lib/judge.ts";

const dir = import.meta.dirname;
const cases = loadCases(join(dir, "cases"));
console.log(`pamA evals: ${cases.length} cases`);

if (cases.length === 0) {
  console.log("no cases yet");
  process.exit(0);
}

const { createHarness } = await import("./lib/harness.ts");
const harness = await createHarness(join(dir, "fixtures"));
const results: { id: string; outcome: Outcome }[] = [];
try {
  for (const c of cases) {
    const answer = await harness.ask(c);
    results.push({ id: c.id, outcome: judge(c, answer, harness.scopeOf(c)) });
  }
} finally {
  await harness.close();
}

const leaks = results.filter((r) => r.outcome.kind === "leak");
const quality = results.filter((r) => r.outcome.kind === "quality");
for (const { id, outcome } of [...leaks, ...quality]) {
  if (outcome.kind !== "pass")
    console.log(`${outcome.kind.toUpperCase()} ${id}: ${outcome.reason}`);
}
console.log(
  `\n${results.length} cases · ${leaks.length} leaks · ${quality.length} quality failures`,
);
process.exit(leaks.length ? 1 : 0);
