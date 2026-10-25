import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { parsePrompt, render } from "../../src/llm/prompts.ts";
import { bootstrapLocal } from "../../src/services/bootstrap-local.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { pglite } from "../helpers/db.ts";

describe("app", () => {
  let t: TestCtx;

  beforeAll(async () => {
    t = await makeCtx(pglite);
  });
  afterAll(() => t.close());

  it("reports health without auth", async () => {
    const res = await t.app.request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      mode: "local",
      db: "pglite",
      version: "0.1.0",
      capabilities: ["branch_lists", "device_login", "drafts", "changes"],
    });
  });

  it("uses the contract error body for unknown routes", async () => {
    const res = await t.app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });

  it("requires the per-launch token on owner routes in local mode", async () => {
    const app = createApp(t.deps);
    const probe = new Hono();
    probe.get("/ping", (c) => c.text("pong"));
    // Mount a probe under /v1 through the same middleware stack.
    app.route("/v1/probe", probe);
    expect((await app.request("/v1/probe/ping")).status).toBe(401);
    const bad = await app.request("/v1/probe/ping", { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    const ok = await app.request("/v1/probe/ping", {
      headers: { authorization: `Bearer ${t.deps.config.localToken}` },
    });
    expect(ok.status).toBe(200);
  });

  it("creates exactly one local workspace", async () => {
    const a = await bootstrapLocal(t.db);
    const b = await bootstrapLocal(t.db);
    expect(a).toBe(b);
    expect(a).toBe(t.deps.workspaceId);
    const rows = await t.db.query<{ n: number; t: number }>(
      "SELECT count(*)::int AS n, max(answer_threshold)::float AS t FROM workspaces",
    );
    expect(rows[0]).toEqual({ n: 1, t: expect.closeTo(0.8, 5) });
  });
});

describe("prompts", () => {
  it("parses versions and renders variables strictly", () => {
    const p = parsePrompt("demo", "---\nversion: 2\n---\nHello {{name}}.\n");
    expect(p.version).toBe("demo@2");
    expect(render(p, { name: "pamA" })).toBe("Hello pamA.");
    expect(() => render(p, {})).toThrow(/missing variable name/);
    expect(() => parsePrompt("x", "no front matter")).toThrow();
  });
});
