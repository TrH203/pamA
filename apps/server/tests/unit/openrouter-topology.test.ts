// OpenRouter as a first-class provider (key required, always cloud) and the topology route.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { staticItems } from "../../src/llm/check.ts";
import { isLocal, language, OPENROUTER_DEFAULT } from "../../src/llm/providers.ts";
import { buildTopology } from "../../src/services/topology.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { pglite } from "../helpers/db.ts";

describe("openrouter provider", () => {
  const p = { provider: "openrouter", model: "openai/gpt-4o-mini" } as const;

  it("is cloud and needs a key", () => {
    expect(isLocal(p)).toBe(false);
    expect(staticItems("chat", p)[0]?.name).toBe("key");
    expect(staticItems("chat", { ...p, apiKey: "sk-or-x" })).toEqual([]);
  });

  it("sends requests to openrouter.ai through the egress guard", async () => {
    const seen: string[] = [];
    const guard = {
      fetchFor: () => async (url: RequestInfo | URL) => {
        seen.push(String(url));
        return new Response("{}", { status: 500 });
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal guard stub
    const m = language({ ...p, apiKey: "sk-or-x" }, guard as any, undefined, "llm.chat") as any;
    await m
      .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
      .catch(() => {});
    expect(seen[0]).toBe(`${OPENROUTER_DEFAULT}/chat/completions`);
  });
});

describe("topology", () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await makeCtx(pglite);
  });
  afterAll(() => t.close());

  it("keeps capture on the device and reports model locality", async () => {
    const res = await t.req("/v1/settings/topology");
    expect(res.status).toBe(200);
    const b = (await res.json()) as ReturnType<typeof buildTopology>;
    const capture = b.components.find((c) => c.id === "capture");
    expect(capture).toMatchObject({ current: "device", movable: false });
    expect(b.dataFlow.at(-1)).toMatch(/raw transcripts never leave/i);
    expect(b.mode).toBe("local");
  });

  it("names the cloud host when a model is cloud", () => {
    const deps = {
      ...t.deps,
      config: {
        ...t.deps.config,
        chat: { provider: "openrouter", model: "m", apiKey: "k" } as const,
      },
    };
    const b = buildTopology(deps, { redact: false });
    expect(b.components.find((c) => c.id === "chat")?.current).toBe("cloud");
    expect(b.dataFlow.join("\n")).toContain("openrouter.ai");
    const hidden = buildTopology(deps, { redact: true });
    expect(JSON.stringify(hidden.declaredHosts)).toBe("[]");
  });
});
