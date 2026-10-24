// Runtime model settings (spec 003): masking, confirmations, offline refusal, revert.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptKey, encryptKey } from "../../src/llm/settings.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { pglite } from "../helpers/db.ts";

const DEAD = "http://127.0.0.1:1/v1";

describe("model settings", () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await makeCtx(pglite);
  });
  afterAll(() => t.close());

  const put = (role: string, json: unknown) =>
    t.req(`/v1/models/settings/${role}`, { method: "PUT", json });

  it("lists the three roles without any key", async () => {
    const res = await t.req("/v1/models/settings");
    expect(res.status).toBe(200);
    const b = (await res.json()) as { roles: Record<string, { source: string; keySet: boolean }> };
    expect(Object.keys(b.roles)).toEqual(["chat", "small", "embed"]);
    expect(b.roles.chat?.source).toBe("env");
  });

  it("rejects an unreachable endpoint unless the owner saves it unverified", async () => {
    const bad = await put("chat", { provider: "openai-compatible", model: "m", baseUrl: DEAD });
    expect(bad.status).toBe(422);
    const b = (await bad.json()) as {
      error: { code: string };
      check: { items: { name: string }[] };
    };
    expect(b.error.code).toBe("check_failed");
    expect(b.check.items[0]?.name).toBe("reachable");

    const ok = await put("chat", {
      provider: "openai-compatible",
      model: "m",
      baseUrl: DEAD,
      apiKey: "sk-secret-123456",
      confirm: ["unverified"],
    });
    expect(ok.status).toBe(200);
    const text = JSON.stringify(await ok.json());
    expect(text).not.toContain("sk-secret-123456");
    expect(text).toContain('"keySet":true');
    expect(text).toContain('"verified":false');
    // Hot swap: the shared config follows.
    expect(t.deps.config.chat.model).toBe("m");
    // Stored encrypted, never in clear.
    const [row] = await t.db.query<{ config: unknown }>(
      "SELECT config FROM model_settings WHERE role = 'chat'",
    );
    expect(JSON.stringify(row)).not.toContain("sk-secret-123456");
  });

  it("reverts to the previous configuration", async () => {
    const res = await t.req("/v1/models/settings/chat/revert", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { provider: string }).provider).toBe("fake");
    const again = await t.req("/v1/models/settings/chat/revert", { method: "POST" });
    expect(again.status).toBe(200); // swaps back
    expect(t.deps.config.chat.model).toBe("m");
  });

  it("needs a key for Anthropic and confirmation for any cloud provider", async () => {
    const nokey = await put("small", { provider: "anthropic", model: "claude-haiku-5-5" });
    expect(nokey.status).toBe(422);
    const cloud = await put("small", {
      provider: "openai-compatible",
      model: "m",
      baseUrl: "https://llm.example.invalid/v1",
      apiKey: "k-123",
    });
    expect(cloud.status).toBe(409);
    const b = (await cloud.json()) as { error: { code: string }; required: string[] };
    expect(b.error.code).toBe("confirmation_required");
    expect(b.required).toEqual(["data_leaves"]);
  });

  it("refuses cloud providers in strict offline mode", async () => {
    t.deps.config.strictOffline = true;
    t.deps.guard.setPolicy({ strict: true, declaredHosts: [] });
    const res = await put("small", {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      apiKey: "k-123",
      confirm: ["data_leaves", "unverified"],
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("offline_blocked");
    t.deps.config.strictOffline = false;
    t.deps.guard.setPolicy({ strict: false, declaredHosts: [] });
  });

  it("checks the active config and a candidate", async () => {
    const active = await t.req("/v1/models/check", { json: { role: "embed" } });
    expect(((await active.json()) as { ok: boolean }).ok).toBe(true);
    const cand = await t.req("/v1/models/check", {
      json: { role: "embed", candidate: { provider: "anthropic", model: "x", apiKey: "k-1" } },
    });
    const r = (await cand.json()) as { ok: boolean; items: { detail: string }[] };
    expect(r.ok).toBe(false);
    expect(r.items[0]?.detail).toMatch(/no embedding API/);
  });

  it("rejects unknown roles and invalid bodies", async () => {
    expect((await put("nope", { provider: "ollama", model: "m" })).status).toBe(422);
    expect((await put("chat", { provider: "ollama" })).status).toBe(422);
  });

  it("encrypts keys round-trip", () => {
    const enc = encryptKey("s".repeat(32), "sk-abc");
    expect(enc).not.toContain("sk-abc");
    expect(decryptKey("s".repeat(32), enc)).toBe("sk-abc");
  });
});
