// Digest pipeline runs (spec 006, migration 0011): one row per digest attempt on this server.
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const RUN_STAGES = ["received", "drafted", "classified", "embedded", "stored"] as const;
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

export const digestRuns = pgTable(
  "digest_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** `transcript`: drafted here from events; `draft`: drafted on a thin-client device. */
    kind: text("kind", { enum: ["transcript", "draft"] }).notNull(),
    agent: text("agent").notNull(),
    agentSessionId: text("agent_session_id").notNull(),
    projectKey: text("project_key"),
    /** Last stage reached. */
    stage: text("stage", { enum: RUN_STAGES }).notNull().default("received"),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("running"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** The model role, provider and model of the failing call, when known. */
    role: text("role"),
    provider: text("provider"),
    model: text("model"),
    digestId: text("digest_id"),
    /** Drafted, cleaned output kept when a later stage failed (retry resumes from embed). */
    resume: jsonb("resume"),
    attempts: integer("attempts").notNull().default(1),
    startedAt: ts("started_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    check("digest_runs_kind", sql`${t.kind} IN ('transcript','draft')`),
    check("digest_runs_status", sql`${t.status} IN ('queued','running','succeeded','failed')`),
    check(
      "digest_runs_stage",
      sql`${t.stage} IN ('received','drafted','classified','embedded','stored')`,
    ),
    index("digest_runs_ws_started").on(t.workspaceId, t.startedAt),
    index("digest_runs_ws_status").on(t.workspaceId, t.status),
    index("digest_runs_session").on(t.workspaceId, t.agent, t.agentSessionId),
  ],
);
