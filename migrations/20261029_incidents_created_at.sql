BEGIN;
-- Source creation time is independent of the local import and closure times.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS itsm_created_at timestamptz;
-- Freeze the existing archive cohort once. Later closures always go above it.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS archive_initial boolean;
UPDATE incidents SET archive_initial=(status<>'active') WHERE archive_initial IS NULL;
ALTER TABLE incidents ALTER COLUMN archive_initial SET DEFAULT false;
ALTER TABLE incidents ALTER COLUMN archive_initial SET NOT NULL;
COMMIT;
