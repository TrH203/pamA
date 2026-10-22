// Runs eval cases through the real server: digests are ingested through Layer 2 (as in
// production), one open Ask Link is created per case, and the question goes through the public
// API (scope → retrieval → answer → Layer 3). Models: the offline fake provider by default, or
// real providers from PAMA_* environment variables.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type Deps } from "@pama/server/src/app.ts";
import { loadConfig, testConfig } from "@pama/server/src/config.ts";
import { openPglite } from "@pama/server/src/db/client.ts";
import { migrate } from "@pama/server/src/db/migrate.ts";
import { createModels } from "@pama/server/src/llm/providers.ts";
import { noMailer } from "@pama/server/src/mail/index.ts";
import { EgressGuard } from "@pama/server/src/net/egress.ts";
import { resolveLink } from "@pama/server/src/policy/resolve-link.ts";
import { loadRuleSet } from "@pama/server/src/safety/rules.ts";
import type { SessionDigest } from "@pama/server/src/schema/digest.ts";
import { bootstrapLocal } from "@pama/server/src/services/bootstrap-local.ts";
import { assignBundle } from "@pama/server/src/services/bundles.ts";
import { cleanAndLabel, storeVersion } from "@pama/server/src/services/digests.ts";
import { createLink } from "@pama/server/src/services/links.ts";
import { upsertProject } from "@pama/server/src/services/projects.ts";
import { ulid } from "ulid";
import type { EvalCase } from "./cases.ts";
import type { EvalAnswer } from "./judge.ts";

interface Fixture {
  project: string;
  project_name: string;
  bundle: string;
  session: string;
  digest: Pick<SessionDigest, "goal" | "decisions" | "outcome" | "open_items" | "modules">;
  labels?: Record<string, ("business_sensitive" | "infra" | "customer")[]>;
}

export interface Harness {
  ask(c: EvalCase): Promise<EvalAnswer>;
  scopeOf(c: EvalCase): Set<string>;
  close(): Promise<void>;
}

const ROOT = join(import.meta.dirname, "../..");

export async function createHarness(fixturesDir: string): Promise<Harness> {
  const real = Boolean(process.env.PAMA_CHAT_PROVIDER && process.env.PAMA_CHAT_PROVIDER !== "fake");
  const config = real
    ? {
        ...loadConfig({
          ...process.env,
          PAMA_MODE: "local",
          PAMA_SECRET: "eval-secret-0123456789-0123456789-ab",
        }),
      }
    : testConfig();
  const db = await openPglite();
  await migrate(db);
  const guard = new EgressGuard(db, { strict: false, declaredHosts: [] });
  const models = createModels(config, guard);
  const rules = loadRuleSet(join(ROOT, "rules"));
  const workspaceId = await bootstrapLocal(db, models.local);
  const deps: Deps = { config, db, models, rules, guard, workspaceId, mailer: noMailer };
  const app = createApp(deps);

  const keys = new Map<string, string>(); // project/bundle key → id
  const raw = readFileSync(join(fixturesDir, "digests.json"), "utf8").replaceAll("{{}}", "");
  for (const f of JSON.parse(raw) as Fixture[]) {
    const project = await upsertProject(db, workspaceId, f.project, f.project_name);
    const bundleId = await assignBundle(db, workspaceId, project.id, f.bundle);
    keys.set(`project:${f.project}`, project.id);
    keys.set(`bundle:${f.bundle}`, bundleId);
    const sessionId = ulid();
    await db.query(
      `INSERT INTO sessions (id, workspace_id, project_id, bundle_id, agent, agent_session_id, ended_at)
       VALUES ($1, $2, $3, $4, 'claude_code', $5, now())`,
      [sessionId, workspaceId, project.id, bundleId, f.session],
    );
    const digest: SessionDigest = {
      schema_version: 1,
      source: {
        agent: "claude_code",
        agent_session_id: f.session,
        project_key: f.project,
        bundle_key: f.bundle,
        ended_at: new Date().toISOString(),
      },
      ...f.digest,
      redactions: { secret: 0, pii: 0 },
    };
    // The same Layer 2 as ingest; fixture labels stand in for the classifier's.
    const cleaned = await cleanAndLabel(deps, digest);
    await storeVersion(deps, {
      sessionId,
      bundleId,
      projectId: project.id,
      digest: cleaned.digest,
      labels: { ...cleaned.labels, ...f.labels },
      status: "approved",
    });
  }

  const scopes = new Map<string, Set<string>>();
  return {
    async ask(c) {
      const sources = c.link.sources.map((s) => {
        const id = keys.get(`${s.type}:${s.key}`);
        if (!id) throw new Error(`${c.id}: unknown ${s.type} ${s.key}`);
        return { type: s.type, id };
      });
      const link = await createLink(deps, {
        title: c.id,
        sources,
        access_mode: "open",
        detail: c.link.detail,
        deny_labels: c.link.deny_labels,
        deny_topics: c.link.deny_topics,
        instruction: c.link.instruction,
        rate_limit_per_hour: 500,
        suggested_questions: ["?"],
      });
      const r = await resolveLink(db, link.slug);
      const allowed = await db.query<{ id: string }>(
        "SELECT id FROM digest_items WHERE session_id = ANY($1) AND active AND NOT (labels && $2::text[])",
        [r.allowedSessionIds, r.denyLabels],
      );
      scopes.set(c.id, new Set(allowed.map((a) => a.id)));
      const res = await app.request(`/a/${link.slug}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
        body: JSON.stringify({ question: c.question }),
      });
      if (res.status !== 200) throw new Error(`${c.id}: HTTP ${res.status} ${await res.text()}`);
      const body = (await res.json()) as EvalAnswer;
      return { ...body, answer: body.answer ?? null };
    },
    scopeOf: (c) => scopes.get(c.id) ?? new Set(),
    close: () => db.close(),
  };
}
