// Owner API for model settings (spec 003, contracts/http-api.md).
import { Hono } from "hono";
import { z } from "zod";
import type { Deps, Env } from "../app.ts";
import type { ProviderConfig } from "../config.ts";
import { errorBody, HttpError } from "../http.ts";
import { type CheckResult, checkProvider } from "../llm/check.ts";
import { resolveProvider } from "../llm/registry.ts";
import {
  ApplySchema,
  applySettings,
  candidateOf,
  effectiveModels,
  parseRole,
  revertSettings,
  runCheck,
  viewSettings,
} from "../llm/settings.ts";
import {
  applyWorkspaceChat,
  assertPublicEndpoint,
  revertWorkspaceChat,
  workspaceChatConfig,
  workspaceChatView,
} from "../llm/workspace-models.ts";
import { body, tenant } from "./util.ts";

const CheckSchema = z.object({
  role: z.enum(["chat", "small", "embed"]),
  candidate: ApplySchema.omit({ confirm: true }).optional(),
});

/**
 * A cloud workspace owner checks candidates only for the chat model, and only on a public
 * endpoint so the check cannot probe the operator's network. Without a candidate they check their
 * own chat model, or the operator's model for the role as a read-only result without its details
 * (so `pama model check` on a paired device sees every role). Nothing is written to the
 * operator's last check.
 */
async function tenantCheck(deps: Deps, b: z.infer<typeof CheckSchema>): Promise<CheckResult> {
  if (b.role !== "chat") {
    if (b.candidate)
      throw new HttpError(403, "forbidden", "Only the server operator checks this model.");
    const r = await checkProvider(b.role, deps.config[b.role], deps.guard, deps.models.fake);
    return { ...r, items: [] };
  }
  const own = await workspaceChatConfig(deps);
  if (b.candidate) {
    const r = resolveProvider(b.candidate.provider, b.candidate.baseUrl);
    const provider = r.provider as ProviderConfig["provider"];
    const apiKey =
      b.candidate.apiKey ??
      (own?.provider === provider && (own.baseUrl ?? "") === (r.baseUrl ?? "")
        ? own.apiKey
        : undefined);
    const cand: ProviderConfig = {
      provider,
      model: b.candidate.model,
      ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
    await assertPublicEndpoint(cand, deps.guard);
    return checkProvider("chat", cand, deps.guard, deps.models.fake, { publicOnly: true });
  }
  if (own) return checkProvider("chat", own, deps.guard, deps.models.fake, { publicOnly: true });
  const r = await checkProvider("chat", deps.config.chat, deps.guard, deps.models.fake);
  return { ...r, items: [] };
}

export const modelRoutes = new Hono<Env>()
  // Spec 005: each role's model and its origin (saved, env, default). Tenants see the operator's
  // choices without endpoints, and their own chat override as scope "workspace".
  .get("/models/effective", async (c) => {
    const deps = c.get("deps");
    if (!tenant(c)) return c.json(await effectiveModels(deps, null));
    const v = await effectiveModels(deps, await workspaceChatConfig(deps));
    for (const x of Object.values(v.roles)) if (x.scope === "server") x.base_url = null;
    return c.json(v);
  })
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
    if (tenant(c)) return c.json(await tenantCheck(deps, b));
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
