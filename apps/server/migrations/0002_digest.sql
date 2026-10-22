CREATE TABLE "bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"key" text,
	"sync_enabled" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"digest_id" text NOT NULL,
	"session_id" text NOT NULL,
	"bundle_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"rationale" text,
	"alternatives" text[] DEFAULT '{}'::text[] NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"embedding" vector(1024),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, '') || ' ' || coalesce(rationale, ''))) STORED,
	"active" boolean DEFAULT false NOT NULL,
	CONSTRAINT "digest_items_kind" CHECK ("digest_items"."kind" IN ('goal','decision','outcome','open_item','module')),
	CONSTRAINT "digest_items_text_len" CHECK (char_length("digest_items"."text") <= 1000),
	CONSTRAINT "digest_items_labels_known" CHECK ("digest_items"."labels" <@ ARRAY['business_sensitive','infra','customer']::text[])
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"version" integer NOT NULL,
	"digest_hash" text NOT NULL,
	"content" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"prompt_version" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digests_status" CHECK ("digests"."status" IN ('draft','approved','superseded','discarded','withdrawn')),
	CONSTRAINT "digests_version_positive" CHECK ("digests"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"repo_key" text NOT NULL,
	"auto_approve" boolean,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"sync_target" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"bundle_id" text NOT NULL,
	"agent" text NOT NULL,
	"agent_session_id" text NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"redaction_counts" jsonb DEFAULT '{"secret":0,"pii":0}'::jsonb NOT NULL,
	"input_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_agent" CHECK ("sessions"."agent" IN ('claude_code','codex'))
);
--> statement-breakpoint
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bundles_project_key" ON "bundles" USING btree ("project_id","key") WHERE "bundles"."key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "digest_items_scope" ON "digest_items" USING btree ("session_id","active");--> statement-breakpoint
CREATE INDEX "digest_items_embedding" ON "digest_items" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "digest_items_tsv" ON "digest_items" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "digests_session_version" ON "digests" USING btree ("session_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "digests_session_hash" ON "digests" USING btree ("session_id","digest_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_repo_key" ON "projects" USING btree ("workspace_id","repo_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_agent_session" ON "sessions" USING btree ("workspace_id","agent","agent_session_id");