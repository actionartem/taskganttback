BEGIN;
-- Source creation time is independent of the local import and closure times.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS itsm_created_at timestamptz;
COMMIT;
