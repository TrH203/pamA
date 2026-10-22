import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { bootstrapLocal } from "./services/bootstrap-local.ts";

const config = loadConfig(process.env);
const db = await openDb(config);
await migrate(db);
if (config.mode === "local") await bootstrapLocal(db);
const app = createApp({ config, db });

serve({ fetch: app.fetch, hostname: config.bind, port: config.port }, (info) => {
  console.log(`pama server (${config.mode}, ${db.kind}) on http://${info.address}:${info.port}`);
});
