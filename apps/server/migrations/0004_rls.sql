-- Row-level security for digest items (Constitution II, research R4). Retrieval runs as the
-- non-superuser role pama_app inside a transaction with the scope in transaction-local settings;
-- the scoped repository applies the same filter in SQL, so both layers must agree.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pama_app') THEN
    CREATE ROLE pama_app NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL; -- created concurrently (roles are cluster-wide)
END
$$;
--> statement-breakpoint
GRANT pama_app TO CURRENT_USER;
--> statement-breakpoint
GRANT SELECT ON digest_items, digests, sessions, bundles TO pama_app;
--> statement-breakpoint
ALTER TABLE digest_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY digest_items_scope ON digest_items FOR SELECT TO pama_app USING (
  active
  AND session_id = ANY (string_to_array(current_setting('pama.allowed_session_ids', true), ','))
  AND NOT (labels && string_to_array(coalesce(current_setting('pama.deny_labels', true), ''), ','))
);
