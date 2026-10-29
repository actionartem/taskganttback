BEGIN;

-- Incidents are independent records: no link to tasks, Jira snapshots or automation.
CREATE TABLE IF NOT EXISTS incidents (
  id BIGSERIAL PRIMARY KEY,
  number varchar(100) NOT NULL CHECK (length(btrim(number)) > 0),
  jira_url text NOT NULL CHECK (jira_url ~ '^https?://'),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  expires_at timestamptz NOT NULL,
  is_deferred boolean NOT NULL DEFAULT false,
  deferred_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incidents_deferral CHECK (
    (NOT is_deferred AND deferred_until IS NULL)
    OR (is_deferred AND deferred_until IS NOT NULL AND deferred_until > expires_at)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_number_unique ON incidents (lower(number));
CREATE INDEX IF NOT EXISTS incidents_deadline_idx
  ON incidents ((CASE WHEN is_deferred THEN deferred_until ELSE expires_at END));

COMMIT;
