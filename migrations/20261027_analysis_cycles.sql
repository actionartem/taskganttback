-- Additive: no existing task, history or document is rewritten.
BEGIN;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS automation_locked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS automation_locked_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS task_az (
  task_id BIGINT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL UNIQUE,
  issue_key TEXT NOT NULL,
  url TEXT NOT NULL,
  epic_key TEXT NOT NULL,
  epic_url TEXT NOT NULL,
  issue_created_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  assignee TEXT,
  checked_at TIMESTAMPTZ NOT NULL,
  history_complete BOOLEAN NOT NULL DEFAULT false,
  status_map JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS task_analysis_events (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('mail','jira')),
  external_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  type TEXT NOT NULL,
  cycle_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_name TEXT,
  source_url TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source,external_id)
);
CREATE INDEX IF NOT EXISTS task_analysis_events_task ON task_analysis_events(task_id,occurred_at,id);
COMMIT;
