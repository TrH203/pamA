// Capture & digest tables (data-model.md): projects, bundles, sessions, digests, digest_items.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { workspaces } from "./core.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/** Embedding dimension of the default model (bge-m3). Changing models re-embeds all items. */
export const EMBED_DIM = 1024;

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Normalized remote URL or path hash; never an absolute local path. */
    repoKey: text("repo_key").notNull(),
    /** Overrides the workspace setting when not null. */
    autoApprove: boolean("auto_approve"),
    syncEnabled: boolean("sync_enabled").notNull().default(false),
    syncTarget: text("sync_target"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("projects_repo_key").on(t.workspaceId, t.repoKey)],
);

export const bundles = pgTable(
  "bundles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Usually the git branch; null for bundles created by split. */
    key: text("key"),
    /** Inherits the project setting when null. */
    syncEnabled: boolean("sync_enabled"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bundles_project_key").on(t.projectId, t.key).where(sql`${t.key} IS NOT NULL`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id),
    agent: text("agent", { enum: ["claude_code", "codex"] }).notNull(),
    agentSessionId: text("agent_session_id").notNull(),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    redactionCounts: jsonb("redaction_counts")
      .$type<{ secret: number; pii: number }>()
      .notNull()
      .default({ secret: 0, pii: 0 }),
    /** sha256 of the last submitted (redacted) events: re-submitting the same input is a no-op. */
    inputHash: text("input_hash"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_agent_session").on(t.workspaceId, t.agent, t.agentSessionId),
    check("sessions_agent", sql`${t.agent} IN ('claude_code','codex')`),
  ],
);

export const DIGEST_STATUSES = [
  "draft",
  "approved",
  "superseded",
  "discarded",
  "withdrawn",
] as const;
export type DigestStatus = (typeof DIGEST_STATUSES)[number];

export const digests = pgTable(
  "digests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** Starts at 1; an edit creates a new row with version + 1. Rows are immutable otherwise. */
    version: integer("version").notNull(),
    /** sha256 of the canonical content: idempotent upserts. */
    digestHash: text("digest_hash").notNull(),
    /** Validates against contracts/session-digest.schema.json. */
    content: jsonb("content").notNull(),
    status: text("status", { enum: DIGEST_STATUSES }).notNull().default("draft"),
    approvedAt: ts("approved_at"),
    approvedBy: text("approved_by"),
    promptVersion: text("prompt_version"),
    model: text("model"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("digests_session_version").on(t.sessionId, t.version),
    uniqueIndex("digests_session_hash").on(t.sessionId, t.digestHash),
    check(
      "digests_status",
      sql`${t.status} IN ('draft','approved','superseded','discarded','withdrawn')`,
    ),
    check("digests_version_positive", sql`${t.version} >= 1`),
  ],
);

export const ITEM_KINDS = ["goal", "decision", "outcome", "open_item", "module"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const digestItems = pgTable(
  "digest_items",
  {
    /** Stable within a digest version, e.g. `<digest_id>#d3`. */
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    digestId: text("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    bundleId: text("bundle_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind", { enum: ITEM_KINDS }).notNull(),
    /** English, at most 1,000 characters. */
    text: text("text").notNull(),
    rationale: text("rationale"),
    alternatives: text("alternatives").array().notNull().default(sql`'{}'::text[]`),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    embedding: vector("embedding", { dimensions: EMBED_DIM }),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(text, '') || ' ' || coalesce(rationale, ''))`,
    ),
    /** False unless the digest is the latest approved version and its source is not tombstoned. */
    active: boolean("active").notNull().default(false),
  },
  (t) => [
    check(
      "digest_items_kind",
      sql`${t.kind} IN ('goal','decision','outcome','open_item','module')`,
    ),
    check("digest_items_text_len", sql`char_length(${t.text}) <= 1000`),
    check(
      "digest_items_labels_known",
      sql`${t.labels} <@ ARRAY['business_sensitive','infra','customer']::text[]`,
    ),
    index("digest_items_scope").on(t.sessionId, t.active),
    index("digest_items_embedding").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("digest_items_tsv").using("gin", t.tsv),
  ],
);
