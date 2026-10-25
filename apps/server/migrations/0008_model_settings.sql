CREATE TABLE "model_settings" (
	"role" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"previous" jsonb,
	"last_check" jsonb,
	"verified" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_settings_role_known" CHECK ("role" IN ('chat','small','embed'))
);
