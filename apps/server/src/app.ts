// Hono application: mounts routes for every mode. Mode-specific behaviour lives in the routes
// and adapters, not in separate apps (Constitution IV).
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { localToken } from "./auth/local-token.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import { errorBody, onError } from "./http.ts";

export interface Deps {
  config: Config;
  db: Db;
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
  const v1 = new Hono<Env>();
  if (deps.config.mode === "local") v1.use(localToken(deps.config.localToken));
  app.route("/v1", v1);

  return app;
}
