// Conversations (spec 008b, migration 0013): the thread an ask belongs to. Raw SQL migration;
// this mirror keeps the drizzle schema in step for typed queries.
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { workspaces } from "./core.ts";
import { askLinks } from "./links.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const CONVERSATION_ORIGINS = ["link", "owner_chat", "hotkey"] as const;
export const CONVERSATION_STATUSES = ["open", "archived"] as const;

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The Ask Link (ask_links is keyed by slug); set only for origin `link`. */
    linkSlug: text("link_slug").references(() => askLinks.slug, { onDelete: "cascade" }),
    visitorId: text("visitor_id"),
    origin: text("origin", { enum: CONVERSATION_ORIGINS }).notNull(),
    title: text("title").notNull().default(""),
    /** owner_chat: the chosen sources ([{type, id}]); null means all approved work. */
    scope: jsonb("scope").$type<{ type: string; id: string }[] | null>(),
    status: text("status", { enum: CONVERSATION_STATUSES }).notNull().default("open"),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastAt: ts("last_at").notNull().defaultNow(),
    /** Hidden from every view once set; purged by the next retention run. */
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    check("conversations_origin", sql`${t.origin} IN ('link','owner_chat','hotkey')`),
    check("conversations_status", sql`${t.status} IN ('open','archived')`),
    check("conversations_link", sql`(${t.origin} = 'link') = (${t.linkSlug} IS NOT NULL)`),
    check("conversations_title_len", sql`char_length(${t.title}) <= 200`),
    index("conversations_workspace_last").on(t.workspaceId, t.lastAt),
    index("conversations_link_visitor").on(t.linkSlug, t.visitorId),
  ],
);
