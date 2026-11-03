-- Digest pipeline observability (spec 006): one row per digest attempt on this server, from
-- `POST /v1/transcripts/digest` (owner's machine) or `POST /v1/sync/drafts` (thin client).
-- `resume` keeps the drafted, cleaned output when a later stage (embed) fails, so a retry runs
-- only the remaining stages. Raw transcripts are never stored here (Constitution I).
CREATE TABLE "digest_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"agent" text NOT NULL,
	"agent_session_id" text NOT NULL,
	"project_key" text,
	"stage" text DEFAULT 'received' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"error_message" text,
	"role" text,
	"provider" text,
	"model" text,
	"digest_id" text,
	"resume" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "digest_runs_kind" CHECK ("kind" IN ('transcript','draft')),
	CONSTRAINT "digest_runs_status" CHECK ("status" IN ('queued','running','succeeded','failed')),
	CONSTRAINT "digest_runs_stage" CHECK ("stage" IN ('received','drafted','classified','embedded','stored'))
);
--> statement-breakpoint
CREATE INDEX "digest_runs_ws_started" ON "digest_runs" USING btree ("workspace_id", "started_at");
--> statement-breakpoint
CREATE INDEX "digest_runs_ws_status" ON "digest_runs" USING btree ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX "digest_runs_session" ON "digest_runs" USING btree ("workspace_id", "agent", "agent_session_id");
