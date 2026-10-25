// Read-only map of where each component runs (Settings → Where things run).
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { workspaceChatConfig } from "../llm/workspace-models.ts";
import { buildTopology } from "../services/topology.ts";
import { tenant } from "./util.ts";

export const topologyRoutes = new Hono<Env>().get("/settings/topology", async (c) => {
  const deps = c.get("deps");
  const redact = tenant(c);
  const chat = redact ? ((await workspaceChatConfig(deps)) ?? undefined) : undefined;
  return c.json(buildTopology(deps, { redact, chat }));
});
