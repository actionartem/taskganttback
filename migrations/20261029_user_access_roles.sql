BEGIN;

-- Job title (role_text) is editable profile text. Access must be stored separately.
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_role text;
UPDATE users SET access_role = CASE
  WHEN lower(coalesce(role_text, '')) ~ '(viewer|read-only|readonly|только чтение|просмотр|наблюдатель)'
    THEN 'viewer'
  ELSE 'editor'
END WHERE access_role IS NULL;
ALTER TABLE users ALTER COLUMN access_role SET DEFAULT 'editor';
ALTER TABLE users ALTER COLUMN access_role SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_access_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_access_role_check
      CHECK (access_role IN ('editor', 'viewer', 'incident_editor'));
  END IF;
END $$;

COMMIT;
