// A wired server for tests: migrated DB, fake models, shared rules, one local workspace.
import { join } from "node:path";
import { createApp, type Deps } from "../../src/app.ts";
import { type Config, testConfig } from "../../src/config.ts";
import type { Db } from "../../src/db/client.ts";
import type { FakeModels, FakePrompt } from "../../src/llm/fake.ts";
import { createModels } from "../../src/llm/providers.ts";
import type { Mailer } from "../../src/mail/index.ts";
import { EgressGuard } from "../../src/net/egress.ts";
import { loadRuleSet } from "../../src/safety/rules.ts";
import { bootstrapLocal } from "../../src/services/bootstrap-local.ts";
import type { DbFactory } from "./db.ts";

export const RULES = loadRuleSet(join(import.meta.dirname, "../../../../rules"));

export interface TestCtx {
  deps: Deps;
  /** Emails "sent" by the server. */
  mails: { to: string; subject: string; text: string }[];
  db: Db;
  fake: FakeModels;
  app: ReturnType<typeof createApp>;
  /** Authenticated request against the app (local token). */
  req(path: string, init?: { method?: string; json?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

export async function makeCtx(f: DbFactory, overrides: Partial<Config> = {}): Promise<TestCtx> {
  const db = await f.create();
  const config = testConfig(overrides);
  const guard = new EgressGuard(db, { strict: false, declaredHosts: [] });
  const models = createModels(config, guard);
  const workspaceId = await bootstrapLocal(db, models.local);
  const mails: TestCtx["mails"] = [];
  const mailer: Mailer = {
    available: true,
    send: async (m) => {
      mails.push(m);
    },
  };
  const deps: Deps = { config, db, models, rules: RULES, guard, workspaceId, mailer };
  const app = createApp(deps);
  const fake = models.fake as FakeModels;
  return {
    deps,
    mails,
    db,
    fake,
    app,
    req: (path, init = {}) =>
      Promise.resolve(
        app.request(path, {
          method: init.method ?? (init.json === undefined ? "GET" : "POST"),
          headers: {
            authorization: `Bearer ${config.localToken}`,
            ...(init.json === undefined ? {} : { "content-type": "application/json" }),
          },
          body: init.json === undefined ? undefined : JSON.stringify(init.json),
        }),
      ),
    close: () => db.close(),
  };
}

/** Route fake LLM calls by the prompt's title line (`# pamA digest`, `# pamA classify`, …). */
export function routeFake(fake: FakeModels, routes: Record<string, (p: FakePrompt) => unknown>) {
  fake.handler = (p) => {
    for (const [name, fn] of Object.entries(routes)) {
      if (p.system.includes(`# pamA ${name}`)) return JSON.stringify(fn(p));
    }
    throw new Error(`no fake route for prompt: ${p.system.slice(0, 60)}`);
  };
}

export const DIGEST_REPLY = {
  goal: "Decide whether refunds include the shipping fee.",
  decisions: [
    {
      what: "Refunds do not include the shipping fee.",
      why: "The carrier fee is already paid and non-refundable.",
      alternatives: ["Refund shipping only for damaged items"],
    },
    {
      what: "Rotate the worker key AKIAZ7Q4PL2XWN3VB5KD after the incident.",
      why: "Contact lan.tran@acme-corp.vn for the rotation schedule.",
      alternatives: [],
    },
  ],
  outcome: "Refund service now excludes shipping; tests added.",
  open_items: ["Confirm policy wording with support"],
  modules: ["refunds", "checkout"],
};

/** Labels every decision that mentions "key" as infra. */
export function classifyReply(p: FakePrompt) {
  const items = [...p.user.matchAll(/^id: (\S+)\ntext: (.*)$/gm)].map((m) => ({
    id: m[1] as string,
    labels: /key|server|database/i.test(m[2] as string) ? ["infra"] : [],
  }));
  return { items };
}

export function transcriptInput(over: Record<string, unknown> = {}) {
  return {
    agent: "claude_code",
    agent_session_id: "sess-1",
    project_key: "github.com/acme/shop",
    project_name: "shop",
    bundle_key: "feat/refund-shipping",
    agent_version: "2.1.0",
    started_at: "2026-10-20T08:00:00Z",
    ended_at: "2026-10-20T09:00:00Z",
    git: { branch: "feat/refund-shipping" },
    events: [
      { kind: "user", text: "Should refunds include the shipping fee?" },
      {
        kind: "assistant",
        text: "Decision: no, because the carrier fee is non-refundable. Rejected: refund for damaged items.",
      },
      { kind: "tool_call", text: "cat .env", tool: "bash", command: "cat .env" },
      { kind: "tool_result", text: "[DROPPED:cat-secret-file]", tool: "bash" },
    ],
    redactions: { secret: 1, pii: 0, by_rule: { "cat-secret-file": 1 } },
    ...over,
  };
}
