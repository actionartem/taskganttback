-- Additive migration. Apply only after backup and explicit production approval.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_action_text TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reply_due_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_for TEXT;

CREATE TABLE IF NOT EXISTS task_events (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT,
  fingerprint TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  changes JSONB NOT NULL DEFAULT '{}',
  actor_name TEXT,
  recorder TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_url TEXT,
  corrects_event_id BIGINT REFERENCES task_events(id),
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS task_events_task_time ON task_events(task_id, received_at DESC, id DESC);
ALTER TABLE task_change_log ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES task_events(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS task_jira (
  task_id BIGINT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  issue_id TEXT,
  issue_key TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT,
  assignee TEXT,
  checked_at TIMESTAMPTZ,
  attempted_at TIMESTAMPTZ,
  error TEXT,
  history_complete BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS task_jira_issue ON task_jira(issue_id) WHERE issue_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_documents (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('az','st','estimate','other')),
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  document_date DATE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_url TEXT,
  file_name TEXT,
  mime_type TEXT,
  file_bytes BYTEA,
  sha256 TEXT,
  is_current BOOLEAN NOT NULL DEFAULT false,
  approved_at TIMESTAMPTZ,
  approval_evidence TEXT,
  event_id BIGINT NOT NULL REFERENCES task_events(id),
  CHECK (source_url IS NOT NULL OR file_bytes IS NOT NULL),
  CHECK (octet_length(file_bytes) <= 10485760)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_documents_current ON task_documents(task_id, kind) WHERE is_current;
CREATE INDEX IF NOT EXISTS task_documents_task ON task_documents(task_id, received_at DESC);

CREATE TABLE IF NOT EXISTS tracker_preferences (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stage_threshold_days JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS attention_snoozes (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reason_key TEXT NOT NULL,
  until_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(user_id, task_id, reason_key)
);
COMMIT;
