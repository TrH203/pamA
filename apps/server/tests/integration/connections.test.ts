// Spec 005: effective models with their origin, and sessions from the new agents.
import agents from "@pama/types/agents.json" with { type: "json" };
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSchema } from "../../src/schema/digest.ts";
import {
  classifyReply,
  DIGEST_REPLY,
  makeCtx,
  routeFake,
  type TestCtx,
  transcriptInput,
} from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

describe("agent registry", () => {
  it("the server accepts exactly the agents in packages/types/agents.json", () => {
    expect(AgentSchema.options).toEqual(agents.agents.map((a) => a.id));
  });
});

describeEachDb("connections", (f) => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(f);
    routeFake(t.fake, { digest: () => DIGEST_REPLY, classify: classifyReply });
  });
  afterEach(() => t.close());

  type Effective = {
    roles: Record<
      string,
      { provider: string; preset: string; origin: string; key_set: boolean; scope: string }
    >;
  };

  it("reports each role's model and where it comes from, never a key", async () => {
    const res = await t.req("/v1/models/effective");
    expect(res.status).toBe(200);
    const b = (await res.json()) as Effective;
    expect(Object.keys(b.roles)).toEqual(["chat", "small", "embed"]);
    // testConfig sets the provider in its env.
    expect(b.roles.chat).toMatchObject({ provider: "fake", origin: "env", scope: "server" });

    const put = await t.req("/v1/models/settings/chat", {
      method: "PUT",
      json: {
        provider: "lmstudio",
        model: "qwen",
        apiKey: "sk-secret-abcdef-123456",
        confirm: ["unverified"],
      },
    });
    expect(put.status).toBe(200);
    const after = await t.req("/v1/models/effective");
    const text = await after.text();
    expect(text).not.toContain("sk-secret-abcdef-123456");
    const v = JSON.parse(text) as Effective;
    expect(v.roles.chat).toMatchObject({
      provider: "openai-compatible",
      preset: "lmstudio",
      origin: "saved",
      key_set: true,
    });
    // Stored under the protocol id, so older devices and servers still read it.
    expect(t.deps.config.chat).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
    });
  });

  it("accepts sessions from Cursor and OpenCode", async () => {
    for (const agent of ["cursor", "opencode"]) {
      const res = await t.req("/v1/transcripts/digest", {
        json: transcriptInput({ agent, agent_session_id: `s-${agent}` }),
      });
      expect(res.status).toBe(200);
    }
    const rows = await t.db.query<{ agent: string }>("SELECT agent FROM sessions ORDER BY agent");
    expect(rows.map((r) => r.agent)).toEqual(["cursor", "opencode"]);
  });
});
