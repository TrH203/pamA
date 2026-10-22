CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status" CHECK ("jobs"."status" IN ('queued','running','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "network_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"component" text NOT NULL,
	"host" text NOT NULL,
	"purpose" text NOT NULL,
	"allowed" boolean NOT NULL,
	CONSTRAINT "network_log_component" CHECK ("network_log"."component" IN ('server','desktop','cli'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_email" text,
	"default_deny_labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"embed_model" text DEFAULT 'bge-m3' NOT NULL,
	"embed_dim" integer DEFAULT 1024 NOT NULL,
	"answer_threshold" real DEFAULT 0.7 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_deny_labels_known" CHECK ("workspaces"."default_deny_labels" <@ ARRAY['business_sensitive','infra','customer']::text[]),
	CONSTRAINT "workspaces_threshold_range" CHECK ("workspaces"."answer_threshold" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("status","run_at");