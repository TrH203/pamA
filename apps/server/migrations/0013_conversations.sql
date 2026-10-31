-- Spec 008b: conversations. Every ask belongs to one conversation: an Ask Link visitor's chat
-- (origin link), the owner's "ask my agent" chat (owner_chat), or the desktop hotkey's drafts
-- (hotkey). `link_slug` is the Ask Link id (ask_links is keyed by slug). `scope` is the owner's
-- chosen sources for owner_chat (null = all approved work). Deleting sets `deleted_at`; the row is
-- hidden at once and purged by the next retention run.
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"link_slug" text,
	"visitor_id" text,
	"origin" text NOT NULL,
	"title" text NOT NULL DEFAULT '',
	"scope" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "conversations_origin" CHECK ("conversations"."origin" IN ('link','owner_chat','hotkey')),
	CONSTRAINT "conversations_status" CHECK ("conversations"."status" IN ('open','archived')),
	CONSTRAINT "conversations_link" CHECK (("conversations"."origin" = 'link') = ("conversations"."link_slug" IS NOT NULL)),
	CONSTRAINT "conversations_title_len" CHECK (char_length("conversations"."title") <= 200)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_link_slug_ask_links_slug_fk" FOREIGN KEY ("link_slug") REFERENCES "public"."ask_links"("slug") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversations_workspace_last" ON "conversations" USING btree ("workspace_id","last_at");
--> statement-breakpoint
CREATE INDEX "conversations_link_visitor" ON "conversations" USING btree ("link_slug","visitor_id");
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "conversation_id" text;
--> statement-breakpoint
ALTER TABLE "asks" DROP CONSTRAINT "asks_origin";
--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_origin" CHECK ("asks"."origin" IN ('link','hotkey','owner_chat'));
--> statement-breakpoint
-- Backfill (documented in specs/008-conversations/plan.md): link asks get one conversation per
-- (link, visitor); hotkey asks get one conversation per workspace and UTC day. Ids are derived
-- from the group key so the asks can be pointed at them in one statement.
INSERT INTO "conversations" ("id", "workspace_id", "link_slug", "visitor_id", "origin", "title", "created_at", "last_at")
SELECT upper(substr(md5('link:' || a.link_slug || ':' || coalesce(a.visitor_id, '')), 1, 26)),
       min(a.workspace_id), a.link_slug, a.visitor_id, 'link',
       left((array_agg(a.question ORDER BY a.created_at))[1], 80),
       min(a.created_at), max(a.created_at)
FROM "asks" a
WHERE a.origin = 'link' AND a.link_slug IS NOT NULL
  AND EXISTS (SELECT 1 FROM "ask_links" l WHERE l.slug = a.link_slug)
GROUP BY a.link_slug, a.visitor_id;
--> statement-breakpoint
INSERT INTO "conversations" ("id", "workspace_id", "origin", "title", "created_at", "last_at")
SELECT upper(substr(md5('hotkey:' || a.workspace_id || ':' || to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')), 1, 26)),
       a.workspace_id, 'hotkey',
       'Drafts ' || to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
       min(a.created_at), max(a.created_at)
FROM "asks" a
WHERE a.origin = 'hotkey'
  AND EXISTS (SELECT 1 FROM "workspaces" w WHERE w.id = a.workspace_id)
GROUP BY a.workspace_id, to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD');
--> statement-breakpoint
UPDATE "asks" a SET "conversation_id" = CASE
    WHEN a.origin = 'link' THEN upper(substr(md5('link:' || a.link_slug || ':' || coalesce(a.visitor_id, '')), 1, 26))
    ELSE upper(substr(md5('hotkey:' || a.workspace_id || ':' || to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')), 1, 26))
  END
WHERE a.conversation_id IS NULL;
--> statement-breakpoint
-- Asks whose link or workspace no longer exists keep a null conversation; the next retention run
-- removes them like any other orphan.
UPDATE "asks" a SET "conversation_id" = NULL
WHERE a.conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c.id = a.conversation_id);
--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "asks_conversation_time" ON "asks" USING btree ("conversation_id","created_at");
--> statement-breakpoint
-- Retention is a workspace setting now (was a fixed 180 days).
ALTER TABLE "workspaces" ADD COLUMN "ask_retention_days" integer DEFAULT 180 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_ask_retention_days" CHECK ("workspaces"."ask_retention_days" BETWEEN 1 AND 3650);
