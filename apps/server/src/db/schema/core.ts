// Foundational tables (data-model.md): workspaces, network_log, jobs.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    /** Null in pure local mode. */
    ownerEmail: text("owner_email"),
    /** Shown to askers ("You are asking <name>'s agent"). */
    displayName: text("display_name").notNull().default("the owner"),
    /** Subset of business_sensitive, infra, customer. */
    defaultDenyLabels: text("default_deny_labels").array().notNull().default(sql`'{}'::text[]`),
    autoApprove: boolean("auto_approve").notNull().default(false),
    embedModel: text("embed_model").notNull().default("bge-m3"),
    embedDim: integer("embed_dim").notNull().default(1024),
    /** 0.7 for cloud models, 0.8 for local models. */
    answerThreshold: real("answer_threshold").notNull().default(0.7),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "workspaces_deny_labels_known",
      sql`${t.defaultDenyLabels} <@ ARRAY['business_sensitive','infra','customer']::text[]`,
    ),
    check("workspaces_threshold_range", sql`${t.answerThreshold} BETWEEN 0 AND 1`),
  ],
);

export const networkLog = pgTable(
  "network_log",
  {
    id: text("id").primaryKey(),
    at: ts("at").notNull().defaultNow(),
    component: text("component", { enum: ["server", "desktop", "cli"] }).notNull(),
    host: text("host").notNull(),
    purpose: text("purpose").notNull(),
    allowed: boolean("allowed").notNull(),
  },
  (t) => [check("network_log_component", sql`${t.component} IN ('server','desktop','cli')`)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("jobs_status", sql`${t.status} IN ('queued','running','done','failed')`),
    index("jobs_due").on(t.status, t.runAt),
  ],
);
