-- Runs once when the database volume is created (as the postgres superuser).
-- The server connects as pama_server (not a superuser); retrieval switches to pama_app so the
-- row-level security policy on digest_items applies (Constitution II, research R4).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE pama_app NOLOGIN;
\set pw `echo "$PAMA_DB_PASSWORD"`
CREATE ROLE pama_server LOGIN PASSWORD :'pw';
GRANT pama_app TO pama_server WITH ADMIN OPTION;
GRANT ALL ON SCHEMA public TO pama_server;
ALTER DATABASE pama OWNER TO pama_server;
