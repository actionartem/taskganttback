ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS approved_hours NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS spent_hours NUMERIC(10, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tasks_approved_hours_nonnegative'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_approved_hours_nonnegative
      CHECK (approved_hours IS NULL OR approved_hours >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tasks_spent_hours_nonnegative'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_spent_hours_nonnegative
      CHECK (spent_hours IS NULL OR spent_hours >= 0);
  END IF;
END $$;
