// Owner sign-in on servers (US5): one-time email login tokens and sessions. Only hashes are stored.
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const loginTokens = pgTable("login_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  email: text("email").notNull(),
  workspaceId: text("workspace_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const ownerSessions = pgTable(
  "owner_sessions",
  {
    idHash: text("id_hash").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    email: text("email").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("owner_sessions_ws").on(t.workspaceId)],
);
