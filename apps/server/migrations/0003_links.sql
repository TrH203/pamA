CREATE TABLE "ask_links" (
	"slug" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"source_refs" jsonb NOT NULL,
	"detail" text DEFAULT 'summary' NOT NULL,
	"deny_labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"deny_topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"instruction" text,
	"access_mode" text DEFAULT 'pin' NOT NULL,
	"pin_hash" text,
	"allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"rate_limit_per_hour" integer DEFAULT 30 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"footer_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ask_links_slug" CHECK (char_length("ask_links"."slug") >= 8),
	CONSTRAINT "ask_links_detail" CHECK ("ask_links"."detail" IN ('headline','summary','technical')),
	CONSTRAINT "ask_links_access" CHECK ("ask_links"."access_mode" IN ('open','pin','email_otp','allowlist')),
	CONSTRAINT "ask_links_pin" CHECK (("ask_links"."access_mode" = 'pin') = ("ask_links"."pin_hash" IS NOT NULL)),
	CONSTRAINT "ask_links_allowlist" CHECK ("ask_links"."access_mode" <> 'allowlist' OR cardinality("ask_links"."allowlist") > 0),
	CONSTRAINT "ask_links_rate" CHECK ("ask_links"."rate_limit_per_hour" BETWEEN 1 AND 500),
	CONSTRAINT "ask_links_instruction" CHECK ("ask_links"."instruction" IS NULL OR char_length("ask_links"."instruction") <= 2000),
	CONSTRAINT "ask_links_deny_labels" CHECK ("ask_links"."deny_labels" <@ ARRAY['business_sensitive','infra','customer']::text[])
);
--> statement-breakpoint
CREATE TABLE "asks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"origin" text NOT NULL,
	"link_slug" text,
	"visitor_id" text,
	"question" text NOT NULL,
	"language" text,
	"status" text DEFAULT 'received' NOT NULL,
	"reason" text,
	"answer" text,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"guard" jsonb,
	"owner_reply" text,
	"owner_replied_at" timestamp with time zone,
	"useful" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asks_question_len" CHECK (char_length("asks"."question") <= 2000),
	CONSTRAINT "asks_status" CHECK ("asks"."status" IN ('received','answered','refused','forwarded','owner_answered','dismissed','drafted')),
	CONSTRAINT "asks_origin" CHECK ("asks"."origin" IN ('link','hotkey'))
);
--> statement-breakpoint
CREATE TABLE "suggested_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"link_slug" text NOT NULL,
	"text" text NOT NULL,
	"rank" integer NOT NULL,
	"edited_by_owner" boolean DEFAULT false NOT NULL,
	CONSTRAINT "suggested_questions_len" CHECK (char_length("suggested_questions"."text") <= 200)
);
--> statement-breakpoint
CREATE TABLE "visitors" (
	"id" text PRIMARY KEY NOT NULL,
	"link_slug" text NOT NULL,
	"email" text,
	"verified_at" timestamp with time zone,
	"granted_at" timestamp with time zone,
	"ip_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"otp_hash" text,
	"otp_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "display_name" text DEFAULT 'the owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "ask_links" ADD CONSTRAINT "ask_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggested_questions" ADD CONSTRAINT "suggested_questions_link_slug_ask_links_slug_fk" FOREIGN KEY ("link_slug") REFERENCES "public"."ask_links"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_link_slug_ask_links_slug_fk" FOREIGN KEY ("link_slug") REFERENCES "public"."ask_links"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asks_link_time" ON "asks" USING btree ("link_slug","created_at");--> statement-breakpoint
CREATE INDEX "asks_workspace_status" ON "asks" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "visitors_link_ip" ON "visitors" USING btree ("link_slug","ip_hash");