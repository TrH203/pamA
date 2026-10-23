CREATE TABLE "session_branches" (
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"event_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "session_branches_session_id_name_pk" PRIMARY KEY("session_id","name"),
	CONSTRAINT "session_branches_event_count" CHECK ("session_branches"."event_count" >= 0),
	CONSTRAINT "session_branches_name_len" CHECK (char_length("session_branches"."name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
ALTER TABLE "bundles" ADD COLUMN "name_source" text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE "bundles" ADD COLUMN "name_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "bundle_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session_branches" ADD CONSTRAINT "session_branches_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_name_source" CHECK ("bundles"."name_source" IN ('key','suggested','owner'));--> statement-breakpoint
UPDATE "bundles" SET "name_source" = CASE WHEN "key" IS NOT NULL AND "name" = "key" THEN 'key' ELSE 'owner' END;--> statement-breakpoint
INSERT INTO "session_branches" ("session_id", "workspace_id", "name", "position", "first_seen_at", "last_seen_at", "event_count")
SELECT DISTINCT ON (d."session_id") d."session_id", s."workspace_id", left(d."content"->'source'->'git'->>'branch', 256), 0, s."started_at", s."ended_at", 0
FROM "digests" d JOIN "sessions" s ON s."id" = d."session_id"
WHERE coalesce(d."content"->'source'->'git'->>'branch', '') <> ''
ORDER BY d."session_id", d."version" DESC
ON CONFLICT DO NOTHING;
