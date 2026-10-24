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
import { body } from "./util.ts";

const CheckSchema = z.object({
  role: z.enum(["chat", "small", "embed"]),
  candidate: ApplySchema.omit({ confirm: true }).optional(),
});

export const modelRoutes = new Hono<Env>()
  .get("/models/settings", async (c) => c.json(await viewSettings(c.get("deps"))))
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
    try {
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
  .post("/models/settings/:role/revert", async (c) =>
    c.json(await revertSettings(c.get("deps"), parseRole(c.req.param("role")))),
  );
