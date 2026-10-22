// Hono application: mounts routes for every mode. Mode-specific behaviour lives in the routes
// and adapters, not in separate apps (Constitution IV).
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { localToken } from "./auth/local-token.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import { errorBody, onError } from "./http.ts";
import type { Models } from "./llm/providers.ts";
import type { Mailer } from "./mail/index.ts";
import type { EgressGuard } from "./net/egress.ts";
import { deviceRoutes, transcriptsGuard } from "./routes/device.ts";
import { inboxRoutes } from "./routes/inbox.ts";
import { linkRoutes } from "./routes/links.ts";
import { publicRoutes } from "./routes/public.ts";
import { reviewRoutes } from "./routes/review.ts";
import { DEFAULT_WEB_DIR, staticRoutes } from "./routes/static.ts";
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

export type Env = { Variables: { deps: Deps; requestId: string } };

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
    }),
  );

  // Owner and device API. In local mode one per-launch token covers both; server modes add
  // owner sessions and device tokens (US4, US5).
  app.route("/v1", transcriptsGuard);
  const v1 = new Hono<Env>();
  if (deps.config.mode === "local") v1.use(localToken(deps.config.localToken));
  v1.route("/", deviceRoutes);
  v1.route("/", reviewRoutes);
  v1.route("/", linkRoutes);
  v1.route("/", inboxRoutes);
  app.route("/v1", v1);
  app.route("/a", publicRoutes);
  app.route("/", staticRoutes(process.env.PAMA_WEB_DIR ?? DEFAULT_WEB_DIR));

  return app;
}
