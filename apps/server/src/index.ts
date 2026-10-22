import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { applyRetention } from "./jobs/retention.ts";
import { createModels } from "./llm/providers.ts";
import { createMailer } from "./mail/index.ts";
import { EgressGuard } from "./net/egress.ts";
import { loadRuleSet } from "./safety/rules.ts";
import { bootstrap } from "./services/bootstrap.ts";

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
// The default workspace; requests on servers act in the device's or signed-in owner's workspace.
const workspaceId = await bootstrap(db, config, models.local);
const mailer = await createMailer(config, guard);
// Daily audit retention.
const retention = () => applyRetention(db).catch((e) => console.error("retention:", e));
void retention();
setInterval(retention, 24 * 3_600_000).unref();
const app = createApp({ config, db, models, rules, guard, workspaceId, mailer });

serve({ fetch: app.fetch, hostname: config.bind, port: config.port }, (info) => {
  console.log(`pama server (${config.mode}, ${db.kind}) on http://${info.address}:${info.port}`);
  if (process.env.PAMA_PRINT_TOKEN === "1") console.log(`token ${config.localToken}`);
});
