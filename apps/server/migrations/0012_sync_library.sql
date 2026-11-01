-- Sync and library (spec 007): task (bundle) changes queued for publish targets, and indexes for
-- the library lists.
ALTER TABLE "sync_outgoing" ADD COLUMN "payload" jsonb;
--> statement-breakpoint
CREATE INDEX "sessions_ws_ended" ON "sessions" USING btree ("workspace_id", "ended_at", "id");
--> statement-breakpoint
CREATE INDEX "digests_ws_status" ON "digests" USING btree ("workspace_id", "status", "created_at");
