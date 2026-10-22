import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { createModels } from "./llm/providers.ts";
import { createMailer } from "./mail/index.ts";
import { EgressGuard } from "./net/egress.ts";
import { loadRuleSet } from "./safety/rules.ts";
import { bootstrapLocal } from "./services/bootstrap-local.ts";

const config = loadConfig(process.env);
const db = await openDb(config);
await migrate(db);
const guard = new EgressGuard(db, {
  strict: config.strictOffline,
  declaredHosts: config.declaredHosts,
});
const models = createModels(config, guard);
const rules = loadRuleSet(
  process.env.PAMA_RULES_DIR ?? join(import.meta.dirname, "../../../rules"),
);
// Server modes resolve the workspace from the owner session (US5); local mode has exactly one.
const workspaceId = await bootstrapLocal(db, models.local);
const mailer = await createMailer(config, guard);
const app = createApp({ config, db, models, rules, guard, workspaceId, mailer });

serve({ fetch: app.fetch, hostname: config.bind, port: config.port }, (info) => {
  console.log(`pama server (${config.mode}, ${db.kind}) on http://${info.address}:${info.port}`);
  if (process.env.PAMA_PRINT_TOKEN === "1") console.log(`token ${config.localToken}`);
});
