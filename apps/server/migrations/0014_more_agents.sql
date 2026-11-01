-- Spec 005: sessions from Cursor and OpenCode (packages/types/agents.json).
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_agent";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent" CHECK ("sessions"."agent" IN ('claude_code','codex','cursor','opencode'));
