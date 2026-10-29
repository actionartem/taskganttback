BEGIN;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS comment text NOT NULL DEFAULT '';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS closure_source text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS closure_deadline_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS itsm_completed_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS itsm_deadline_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS next_check_at timestamptz DEFAULT now();
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS check_error text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incidents_comment_length' AND conrelid='incidents'::regclass) THEN
    ALTER TABLE incidents ADD CONSTRAINT incidents_comment_length CHECK (char_length(comment)<=10000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incidents_closure' AND conrelid='incidents'::regclass) THEN
    ALTER TABLE incidents ADD CONSTRAINT incidents_closure CHECK (
      (status='active' AND closed_at IS NULL AND closure_source IS NULL)
      OR (status IN ('completed','burned') AND closed_at IS NOT NULL AND closure_source IN ('manual','itsm'))
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS incidents_open_check_idx ON incidents(next_check_at) WHERE status='active';
COMMIT;
