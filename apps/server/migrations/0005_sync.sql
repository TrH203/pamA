CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_deliveries" (
	"digest_id" text NOT NULL,
	"target" text NOT NULL,
	"handed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_deliveries_digest_id_target_pk" PRIMARY KEY("digest_id","target")
);
--> statement-breakpoint
CREATE TABLE "sync_outgoing" (
	"id" text PRIMARY KEY NOT NULL,
	"target" text NOT NULL,
	"source_type" text NOT NULL,
	"source_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_receipts" (
	"outbox_id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_key" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_tombstones_type" CHECK ("sync_tombstones"."source_type" IN ('project','bundle','session'))
);
--> statement-breakpoint
ALTER TABLE "bundles" ADD COLUMN "sync_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sync_enabled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "devices_prefix" ON "devices" USING btree ("token_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_outgoing_pending" ON "sync_outgoing" USING btree ("target","source_type","source_key") WHERE "sync_outgoing"."handed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sync_tombstones_key" ON "sync_tombstones" USING btree ("workspace_id","source_type","source_key");