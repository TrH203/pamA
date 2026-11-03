// Spec 005: the server reads the same provider registry as the device; the shared fixture is also
// checked by crates/pama-core/src/providers.rs (shared_fixture_parity).
import fixture from "@pama/types/fixtures/provider-locality.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import {
  isLocalProvider,
  PROVIDER_IDS,
  presetFor,
  REGISTRY,
  resolveProvider,
} from "../../src/llm/registry.ts";

describe("provider registry", () => {
  it("lists the shared ids in the same order as the device", () => {
    expect(PROVIDER_IDS).toEqual(fixture.ids);
  });

  it("agrees with the device on locality", () => {
    for (const c of fixture.is_local) {
      expect([
        c.provider,
        c.base_url,
        isLocalProvider(c.provider, c.base_url ?? undefined),
      ]).toEqual([c.provider, c.base_url, c.local]);
    }
  });

  it("agrees with the device on which preset an endpoint is", () => {
    for (const c of fixture.preset_for) {
      expect(presetFor(c.provider, c.base_url ?? undefined)?.id).toBe(c.preset);
    }
  });

  it("maps new ids onto the stored protocols and keeps legacy ids", () => {
    expect(resolveProvider("lmstudio")).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
    });
    expect(resolveProvider("deepinfra", "https://x.example/v1")).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://x.example/v1",
    });
    for (const id of ["ollama", "anthropic", "openrouter", "openai-compatible"]) {
      expect(resolveProvider(id)).toEqual({ provider: id });
    }
    expect(resolveProvider("fake")).toEqual({ provider: "fake" });
  });

  it("every preset uses a provider that serves its role", () => {
    for (const p of REGISTRY.presets) {
      for (const [role, r] of Object.entries(p.roles)) {
        const entry = REGISTRY.providers.find((x) => x.id === r?.provider);
        expect(entry?.roles, `${p.id} ${role}`).toContain(role);
      }
    }
  });

  it("accepts registry ids in the environment and records where models came from", () => {
    const c = loadConfig({
      PAMA_MODE: "local",
      PAMA_SECRET: "test-secret-0123456789-0123456789-abcdef",
      PAMA_CHAT_PROVIDER: "lmstudio",
      PAMA_CHAT_MODEL: "qwen",
    });
    expect(c.chat).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
    });
    expect(c.modelOrigin).toEqual({ chat: "env", small: "env", embed: "default" });
  });
});
