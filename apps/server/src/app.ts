// Hono application: mounts routes for every mode. Mode-specific behaviour lives in the routes
// and adapters, not in separate apps (Constitution IV).
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import type { Device } from "./auth/device.ts";
import { authenticate } from "./auth/index.ts";
import { authRoutes } from "./auth/magic-link.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import { errorBody, onError } from "./http.ts";
import type { Models } from "./llm/providers.ts";
import type { Mailer } from "./mail/index.ts";
import type { EgressGuard } from "./net/egress.ts";
import { deviceRoutes } from "./routes/device.ts";
import { devicesRoutes } from "./routes/devices.ts";
import { draftRoutes } from "./routes/draft.ts";
import { inboxRoutes } from "./routes/inbox.ts";
import { linkRoutes } from "./routes/links.ts";
import { networkLogRoutes } from "./routes/network-log.ts";
import { publicRoutes } from "./routes/public.ts";
import { reviewRoutes } from "./routes/review.ts";
import { DEFAULT_WEB_DIR, staticRoutes } from "./routes/static.ts";
import { syncRoutes } from "./routes/sync.ts";
import { syncLocalRoutes } from "./routes/sync-local.ts";
import type { RuleSet } from "./safety/rules.ts";

export interface Deps {
  config: Config;
  db: Db;
  models: Models;
  rules: RuleSet;
  guard: EgressGuard;
  /** The workspace served by this process (single owner per workspace in this release). */
  workspaceId: string;
  mailer: Mailer;
}

export type Env = { Variables: { deps: Deps; requestId: string; device: Device } };

export function createApp(deps: Deps) {
  const app = new Hono<Env>();
  app.use(requestId());
  app.use(async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.onError(onError);
  app.notFound((c) => c.json(errorBody("not_found", "not found"), 404));

  app.get("/v1/health", (c) =>
    c.json({
      status: "ok",
      mode: deps.config.mode,
      db: deps.db.kind,
      version: deps.config.version,
      /** Optional features a sync client may rely on; absent on older servers. */
      capabilities: ["branch_lists"],
    }),
  );

  // Owner and device API: who may call what is decided in one place (auth/index.ts).
  app.use("/v1/*", authenticate());
  for (const r of [
    authRoutes,
    deviceRoutes,
    reviewRoutes,
    linkRoutes,
    inboxRoutes,
    draftRoutes,
    devicesRoutes,
    syncRoutes,
    syncLocalRoutes,
    networkLogRoutes,
  ]) {
    app.route("/v1", r);
  }
  app.route("/a", publicRoutes);
  app.route("/", staticRoutes(process.env.PAMA_WEB_DIR ?? DEFAULT_WEB_DIR));

  return app;
}
