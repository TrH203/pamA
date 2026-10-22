// Sync (US4, data-model.md): devices and pairing codes on the receiving server; tombstones with
// portable source keys (project_key, bundle_key, agent session id) because ids differ between
// the owner's machine and the server; delivery bookkeeping on the owner's machine.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    /** scrypt hash of the device token (never stored in clear). */
    tokenHash: text("token_hash").notNull(),
    /** First 8 characters of the token, to find the row without scanning hashes. */
    tokenPrefix: text("token_prefix").notNull(),
    lastSeenAt: ts("last_seen_at"),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("devices_prefix").on(t.tokenPrefix)],
);

export const pairingCodes = pgTable("pairing_codes", {
  codeHash: text("code_hash").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const syncTombstones = pgTable(
  "sync_tombstones",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceType: text("source_type", { enum: ["project", "bundle", "session"] }).notNull(),
    /** Portable key: "<project_key>", "<project_key>#<bundle_key>" or "<agent>:<agent_session_id>". */
    sourceKey: text("source_key").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    check("sync_tombstones_type", sql`${t.sourceType} IN ('project','bundle','session')`),
    index("sync_tombstones_key").on(t.workspaceId, t.sourceType, t.sourceKey),
  ],
);

/** Idempotency: one row per outbox item a device delivered. */
export const syncReceipts = pgTable("sync_receipts", {
  outboxId: text("outbox_id").primaryKey(),
  deviceId: text("device_id").notNull(),
  result: jsonb("result").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

/** On the owner's machine: digests already handed to the device outbox, per target. */
export const syncDeliveries = pgTable(
  "sync_deliveries",
  {
    digestId: text("digest_id").notNull(),
    target: text("target").notNull(),
    handedAt: ts("handed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.digestId, t.target] })],
);

/** On the owner's machine: tombstones waiting to be handed to the device outbox. */
export const syncOutgoing = pgTable(
  "sync_outgoing",
  {
    id: text("id").primaryKey(),
    target: text("target").notNull(),
    sourceType: text("source_type", { enum: ["project", "bundle", "session"] }).notNull(),
    sourceKey: text("source_key").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    handedAt: ts("handed_at"),
  },
  (t) => [
    uniqueIndex("sync_outgoing_pending")
      .on(t.target, t.sourceType, t.sourceKey)
      .where(sql`${t.handedAt} IS NULL`),
  ],
);
