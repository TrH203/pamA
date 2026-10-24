-- Thin client (spec 004): device login, drafts from devices, review pull-back, per-workspace
-- answering model.
CREATE TABLE "device_auth_requests" (
	"device_code_hash" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"device_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"workspace_id" text,
	"device_id" text,
	"token_once" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_auth_requests_status" CHECK ("status" IN ('pending','approved','denied','consumed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_auth_requests_user_code" ON "device_auth_requests" USING btree ("user_code");
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN "next" text;
--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "origin_device_id" text;
--> statement-breakpoint
-- Every review-state change gets a new number: devices pull changes after their last seen number.
CREATE SEQUENCE "digests_review_seq";
--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "review_seq" bigint;
--> statement-breakpoint
CREATE FUNCTION pama_digest_review_seq() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.review_seq := nextval('digests_review_seq');
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER digests_review_seq BEFORE INSERT OR UPDATE ON "digests"
  FOR EACH ROW EXECUTE FUNCTION pama_digest_review_seq();
--> statement-breakpoint
CREATE INDEX "digests_review_seq_ws" ON "digests" USING btree ("workspace_id", "review_seq");
--> statement-breakpoint
CREATE TABLE "workspace_model_settings" (
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_model_settings_pk" PRIMARY KEY ("workspace_id", "role"),
	CONSTRAINT "workspace_model_settings_role" CHECK ("role" IN ('chat'))
);
