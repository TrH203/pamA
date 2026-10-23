// Performance checks (plan.md Performance Goals, SC-003/SC-008). Runs the real server pipeline
// in-process with the offline models, so it measures pamA's own overhead; real model latency adds
// on top (check that separately with your provider). Also checks the sidecar binary size.
//   pnpm --filter @pama/server exec tsx ../../scripts/perf/bench.mts
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { testConfig } from "../../apps/server/src/config.ts";
import { openPglite } from "../../apps/server/src/db/client.ts";
import { migrate } from "../../apps/server/src/db/migrate.ts";
import { seed } from "../../apps/server/src/demo/seed.ts";
import { createModels } from "../../apps/server/src/llm/providers.ts";
import { noMailer } from "../../apps/server/src/mail/index.ts";
import { EgressGuard } from "../../apps/server/src/net/egress.ts";
import { loadRuleSet } from "../../apps/server/src/safety/rules.ts";
import { bootstrapLocal } from "../../apps/server/src/services/bootstrap-local.ts";
import { createLink } from "../../apps/server/src/services/links.ts";

const ROOT = join(import.meta.dirname, "../..");
const N = Number(process.env.PERF_N ?? 30);
const p = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;

const config = testConfig();
const db = await openPglite();
await migrate(db);
const guard = new EgressGuard(db, { strict: false, declaredHosts: [] });
const models = createModels(config, guard);
const workspaceId = await bootstrapLocal(db, models.local);
const deps = {
  config,
  db,
  models,
  rules: loadRuleSet(join(ROOT, "rules")),
  guard,
  workspaceId,
  mailer: noMailer,
};
const s = await seed(deps);
const app = createApp(deps);
const auth = { authorization: `Bearer ${config.localToken}`, "content-type": "application/json" };

async function time(fn: () => Promise<unknown>) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

const draft: number[] = [];
const digest: number[] = [];
const ask: number[] = [];
const link = await createLink(deps, {
  sources: [{ type: "bundle", id: s.bundleRefund }],
  access_mode: "open",
  rate_limit_per_hour: 500,
});
for (let i = 0; i < N; i++) {
  draft.push(
    await time(() =>
      app.request("/v1/draft", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ question: "Do refunds include the shipping fee?" }),
      }),
    ),
  );
  ask.push(
    await time(() =>
      app.request(`/a/${link.slug}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Do refunds include the shipping fee?" }),
      }),
    ),
  );
  digest.push(
    await time(() =>
      app.request("/v1/transcripts/digest", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          agent: "codex",
          agent_session_id: `perf-${i}`,
          project_key: "github.com/acme/shop",
          ended_at: "2026-10-22T10:00:00Z",
          events: Array.from({ length: 200 }, (_, k) => ({
            kind: k % 2 ? "assistant" : "user",
            text: `Step ${k}: decided to keep refunds separate from shipping because carriers do not refund.`,
          })),
          redactions: { secret: 0, pii: 0 },
        }),
      }),
    ),
  );
}
await db.close();

const sidecar = join(ROOT, "crates/pama-desktop/src-tauri/binaries");
const bins = existsSync(sidecar)
  ? (await import("node:fs"))
      .readdirSync(sidecar)
      .map((f) => ({ f, mb: statSync(join(sidecar, f)).size / 2 ** 20 }))
  : [];

const rows: [string, string, string, boolean][] = [
  [
    "hotkey draft p90 (pamA only)",
    `${p(draft, 0.9).toFixed(0)} ms`,
    "≤ 3000 ms incl. model",
    p(draft, 0.9) < 1000,
  ],
  [
    "Ask Link answer p90 (pamA only)",
    `${p(ask, 0.9).toFixed(0)} ms`,
    "≤ 6000 ms incl. model",
    p(ask, 0.9) < 1000,
  ],
  [
    "digest, 200 events p95 (pamA only)",
    `${p(digest, 0.95).toFixed(0)} ms`,
    "≤ 2 min incl. model",
    p(digest, 0.95) < 10_000,
  ],
  ...bins.map(
    (b) =>
      [`sidecar ${b.f}`, `${b.mb.toFixed(0)} MB`, "≤ 120 MB", b.mb <= 120] as [
        string,
        string,
        string,
        boolean,
      ],
  ),
];
for (const [name, got, target, ok] of rows)
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(38)} ${got.padStart(9)}   target ${target}`);
console.log(
  "\nDesktop idle memory: scripts/perf/desktop-memory.sh <pid> (target ≤ 200 MB incl. sidecar)",
);
process.exit(rows.every((r) => r[3]) ? 0 : 1);
