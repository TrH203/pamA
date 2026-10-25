-- Device store (data-model.md). Raw transcripts are never copied: only path and hash.
CREATE TABLE IF NOT EXISTS captured_session (
  id                TEXT PRIMARY KEY,
  agent             TEXT NOT NULL CHECK (agent IN ('claude_code', 'codex')),
  agent_session_id  TEXT NOT NULL,
  transcript_path   TEXT NOT NULL,
  transcript_sha256 TEXT,
  cwd               TEXT,
  repo_remote       TEXT,
  git_branch        TEXT,
  reason            TEXT,
  status            TEXT NOT NULL CHECK (status IN
                      ('detected', 'redacting', 'digesting', 'ready_for_review', 'submitted', 'failed', 'skipped')),
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL DEFAULT 0,
  ended_at          INTEGER NOT NULL,
  processed_at      INTEGER,
  UNIQUE (agent, agent_session_id)
);

CREATE TABLE IF NOT EXISTS outbox_item (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('digest_upsert', 'source_tombstone', 'bundle_change')),
  target          TEXT NOT NULL,
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox_item (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS network_log (
  id        TEXT PRIMARY KEY,
  at        INTEGER NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('server', 'desktop', 'cli')),
  host      TEXT NOT NULL,
  purpose   TEXT NOT NULL,
  allowed   INTEGER NOT NULL
);

-- Thin client (spec 004): the device's copy of every digest it drafted for a remote server. The
-- device is the source of truth; review decisions made on the server are pulled back into it.
CREATE TABLE IF NOT EXISTS remote_digest (
  target            TEXT NOT NULL,
  agent             TEXT NOT NULL,
  agent_session_id  TEXT NOT NULL,
  project_key       TEXT NOT NULL,
  digest            TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'discarded', 'deleted')),
  server_digest_id  TEXT,
  version           INTEGER,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (target, agent, agent_session_id)
);
