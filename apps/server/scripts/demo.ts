// Demo server: in-memory PGlite, offline models, seeded approved digests and two Ask Links.
// `pnpm --filter @pama/server demo` — also used by the Playwright tests (PAMA_DEMO_OUT).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.ts";
import { testConfig } from "../src/config.ts";
import { openPglite } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { seed } from "../src/demo/seed.ts";
import { createModels } from "../src/llm/providers.ts";
import type { Mail, Mailer } from "../src/mail/index.ts";
import { EgressGuard } from "../src/net/egress.ts";
import { loadRuleSet } from "../src/safety/rules.ts";
import { bootstrapLocal } from "../src/services/bootstrap-local.ts";
import { createLink } from "../src/services/links.ts";

const port = Number(process.env.PAMA_PORT ?? 7470);
const config = testConfig({ port, baseUrl: `http://127.0.0.1:${port}` });
const db = await openPglite();
await migrate(db);
const guard = new EgressGuard(db, { strict: false, declaredHosts: [] });
const models = createModels(config, guard);
const workspaceId = await bootstrapLocal(db, models.local);
await db.query("UPDATE workspaces SET display_name = 'Hien' WHERE id = $1", [workspaceId]);
const mails: Mail[] = [];
const mailer: Mailer = { available: true, send: async (m) => void mails.push(m) };
const deps = {
  config,
  db,
  models,
  rules: loadRuleSet(join(import.meta.dirname, "../../../rules")),
  guard,
  workspaceId,
  mailer,
};
const s = await seed(deps);
const pin = await createLink(deps, {
  title: "Refund policy",
  sources: [{ type: "bundle", id: s.bundleRefund }],
  access_mode: "pin",
  pin: "4821",
});
const open = await createLink(deps, {
  title: "Checkout work",
  sources: [{ type: "project", id: s.projectA }],
  access_mode: "open",
  deny_labels: ["infra", "business_sensitive"],
});

const app = createApp(deps);
app.get("/__demo/mails", (c) => c.json(mails));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  const info = {
    base: config.baseUrl,
    token: config.localToken,
    pinLink: pin.url,
    pin: "4821",
    openLink: open.url,
  };
  if (process.env.PAMA_DEMO_OUT) {
    mkdirSync(dirname(process.env.PAMA_DEMO_OUT), { recursive: true });
    writeFileSync(process.env.PAMA_DEMO_OUT, JSON.stringify(info));
  }
  console.log(`pamA demo on ${config.baseUrl}`);
  console.log(`console: ${config.baseUrl}/#token=${config.localToken}`);
  console.log(`PIN link: ${pin.url} (PIN 4821)\nopen link: ${open.url}`);
});
