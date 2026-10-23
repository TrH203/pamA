// Ask Link tables (data-model.md): ask_links, suggested_questions, visitors, asks.
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
import { workspaces } from "./core.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const ACCESS_MODES = ["open", "pin", "email_otp", "allowlist"] as const;
export const DETAIL_LEVELS = ["headline", "summary", "technical"] as const;

export const askLinks = pgTable(
  "ask_links",
  {
    /** 8+ chars, base32, unguessable. */
    slug: text("slug").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** [{type: project|bundle|session, id}], resolved to session ids at query time. */
    sourceRefs: jsonb("source_refs").$type<{ type: string; id: string }[]>().notNull(),
    detail: text("detail", { enum: DETAIL_LEVELS }).notNull().default("summary"),
    /** Always a superset of the workspace defaults (enforced at resolve time). */
    denyLabels: text("deny_labels").array().notNull().default(sql`'{}'::text[]`),
    denyTopics: text("deny_topics").array().notNull().default(sql`'{}'::text[]`),
    /** At most 2,000 characters; treated as owner policy. */
    instruction: text("instruction"),
    accessMode: text("access_mode", { enum: ACCESS_MODES }).notNull().default("pin"),
    pinHash: text("pin_hash"),
    allowlist: text("allowlist").array().notNull().default(sql`'{}'::text[]`),
    rateLimitPerHour: integer("rate_limit_per_hour").notNull().default(30),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    footerEnabled: boolean("footer_enabled").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("ask_links_slug", sql`char_length(${t.slug}) >= 8`),
    check("ask_links_detail", sql`${t.detail} IN ('headline','summary','technical')`),
    check("ask_links_access", sql`${t.accessMode} IN ('open','pin','email_otp','allowlist')`),
    check("ask_links_pin", sql`(${t.accessMode} = 'pin') = (${t.pinHash} IS NOT NULL)`),
    check(
      "ask_links_allowlist",
      sql`${t.accessMode} <> 'allowlist' OR cardinality(${t.allowlist}) > 0`,
    ),
    check("ask_links_rate", sql`${t.rateLimitPerHour} BETWEEN 1 AND 500`),
    check(
      "ask_links_instruction",
      sql`${t.instruction} IS NULL OR char_length(${t.instruction}) <= 2000`,
    ),
    check(
      "ask_links_deny_labels",
      sql`${t.denyLabels} <@ ARRAY['business_sensitive','infra','customer']::text[]`,
    ),
  ],
);

export const suggestedQuestions = pgTable(
  "suggested_questions",
  {
    id: text("id").primaryKey(),
    linkSlug: text("link_slug")
      .notNull()
      .references(() => askLinks.slug, { onDelete: "cascade" }),
    text: text("text").notNull(),
    rank: integer("rank").notNull(),
    editedByOwner: boolean("edited_by_owner").notNull().default(false),
  },
  (t) => [check("suggested_questions_len", sql`char_length(${t.text}) <= 200`)],
);

export const visitors = pgTable(
  "visitors",
  {
    id: text("id").primaryKey(),
    linkSlug: text("link_slug")
      .notNull()
      .references(() => askLinks.slug, { onDelete: "cascade" }),
    email: text("email"),
    verifiedAt: ts("verified_at"),
    /** Access granted (open link, right PIN, verified email). */
    grantedAt: ts("granted_at"),
    ipHash: text("ip_hash").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: ts("locked_until"),
    otpHash: text("otp_hash"),
    otpExpiresAt: ts("otp_expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("visitors_link_ip").on(t.linkSlug, t.ipHash)],
);

export const ASK_STATUSES = [
  "received",
  "answered",
  "refused",
  "forwarded",
  "owner_answered",
  "dismissed",
  "drafted",
] as const;

export const asks = pgTable(
  "asks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    origin: text("origin", { enum: ["link", "hotkey"] }).notNull(),
    linkSlug: text("link_slug"),
    visitorId: text("visitor_id"),
    question: text("question").notNull(),
    /** Detected BCP-47 language. */
    language: text("language"),
    status: text("status", { enum: ASK_STATUSES }).notNull().default("received"),
    reason: text("reason"),
    answer: text("answer"),
    citations: jsonb("citations")
      .$type<{ item_id: string; digest_id: string; digest_version: number }[]>()
      .notNull()
      .default([]),
    confidence: real("confidence"),
    guard: jsonb("guard").$type<{
      leak: boolean;
      off_scope: boolean;
      unsupported_claims: boolean;
      rule_hits: string[];
    }>(),
    ownerReply: text("owner_reply"),
    ownerRepliedAt: ts("owner_replied_at"),
    /** Asker feedback after an answer (SC-006): true useful, false not useful. */
    useful: boolean("useful"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("asks_question_len", sql`char_length(${t.question}) <= 2000`),
    check(
      "asks_status",
      sql`${t.status} IN ('received','answered','refused','forwarded','owner_answered','dismissed','drafted')`,
    ),
    check("asks_origin", sql`${t.origin} IN ('link','hotkey')`),
    index("asks_link_time").on(t.linkSlug, t.createdAt),
    index("asks_workspace_status").on(t.workspaceId, t.status),
  ],
);
