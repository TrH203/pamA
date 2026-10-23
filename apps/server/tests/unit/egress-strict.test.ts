// Strict offline mode on the server (FR-027, SC-007): model providers pointing at undeclared
// hosts are blocked before any request leaves; the attempt is in the network log.
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testConfig } from "../../src/config.ts";
import type { Db } from "../../src/db/client.ts";
import { createModels } from "../../src/llm/providers.ts";
import { EgressBlockedError, EgressGuard } from "../../src/net/egress.ts";
import { pglite } from "../helpers/db.ts";

describe("strict offline with real providers", () => {
  let db: Db;
  const fetchSpy = vi.fn(async () => new Response("{}"));
  beforeEach(async () => {
    db = await pglite.create();
    fetchSpy.mockClear();
  });
  afterEach(() => db.close());

  it("blocks a cloud model and logs it; nothing is fetched", async () => {
    const guard = new EgressGuard(
      db,
      { strict: true, declaredHosts: ["ollama.lan:11434"] },
      fetchSpy,
    );
    const config = testConfig({
      chat: { provider: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-test" },
      small: { provider: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-test" },
      embed: { provider: "ollama", model: "bge-m3", baseUrl: "http://ollama.lan:11434" },
    });
    const models = createModels(config, guard);
    expect(models.local).toBe(false);
    await expect(
      generateText({ model: models.chat, prompt: "hi", maxRetries: 0 }),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    const log = await db.query<{ host: string; allowed: boolean }>(
      "SELECT host, allowed FROM network_log",
    );
    expect(log).toEqual([{ host: "api.anthropic.com", allowed: false }]);
  });

  it("allows the declared local model host", async () => {
    const guard = new EgressGuard(
      db,
      { strict: true, declaredHosts: ["ollama.lan:11434"] },
      fetchSpy,
    );
    await guard.fetch("http://ollama.lan:11434/api/embed", { method: "POST" }, "llm.embed");
    expect(fetchSpy).toHaveBeenCalledOnce();
    await expect(guard.assertAllowed("api.openai.com", "llm")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });
});
