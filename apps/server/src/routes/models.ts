// Owner API for model settings (spec 003, contracts/http-api.md).
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { errorBody, HttpError } from "../http.ts";
import { checkProvider } from "../llm/check.ts";
import {
  ApplySchema,
  applySettings,
  candidateOf,
  parseRole,
  revertSettings,
  runCheck,
  viewSettings,
} from "../llm/settings.ts";
import {
  applyWorkspaceChat,
  revertWorkspaceChat,
  workspaceChatView,
} from "../llm/workspace-models.ts";
import { body } from "./util.ts";

/** Cloud servers: workspace owners manage only their own chat model (FR-026). */
const tenant = (c: {
  get(k: "deps"): Env["Variables"]["deps"];
  get(k: "actor"): Env["Variables"]["actor"];
}) => c.get("deps").config.mode === "cloud" && c.get("actor") === "workspace";

const CheckSchema = z.object({
  role: z.enum(["chat", "small", "embed"]),
  candidate: ApplySchema.omit({ confirm: true }).optional(),
});

export const modelRoutes = new Hono<Env>()
  .get("/models/settings", async (c) => {
    const deps = c.get("deps");
    const v = await viewSettings(deps);
    if (!tenant(c)) return c.json(v);
    // Tenants see the operator's choices without its endpoints, plus their own override.
    const roles = Object.fromEntries(
      Object.entries(v.roles).map(([r, x]) => {
        const { baseUrl: _b, previous: _p, lastCheck: _l, ...rest } = x;
        return [r, { ...rest, scope: "server" }];
      }),
    );
    const own = await workspaceChatView(deps);
    if (own) roles.chat = own;
    return c.json({ ...v, roles });
  })
  .post("/models/check", async (c) => {
    const deps = c.get("deps");
    const b = await body(c, CheckSchema);
    if (!b.candidate) return c.json(await runCheck(deps, b.role, deps.config[b.role]));
    const cand = candidateOf(deps, b.role, { ...b.candidate, confirm: [] });
    return c.json(await checkProvider(b.role, cand, deps.guard, deps.models.fake));
  })
  .put("/models/settings/:role", async (c) => {
    const role = parseRole(c.req.param("role"));
    const input = await body(c, ApplySchema);
    if (tenant(c) && role !== "chat") {
      throw new HttpError(403, "forbidden", "Only the server operator changes this model.");
    }
    try {
      if (tenant(c)) return c.json(await applyWorkspaceChat(c.get("deps"), input));
      return c.json(await applySettings(c.get("deps"), role, input));
    } catch (e) {
      if (e instanceof HttpError) {
        const extra = e as HttpError & { required?: string[]; check?: unknown };
        return c.json(
          { ...errorBody(e.code, e.message), required: extra.required, check: extra.check },
          e.status,
        );
      }
      throw e;
    }
  })
  .post("/models/settings/:role/revert", async (c) => {
    const role = parseRole(c.req.param("role"));
    if (tenant(c)) {
      if (role !== "chat")
        throw new HttpError(403, "forbidden", "Only the server operator changes this model.");
      return c.json(await revertWorkspaceChat(c.get("deps")));
    }
    return c.json(await revertSettings(c.get("deps"), role));
  });
