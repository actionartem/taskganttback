CREATE TABLE IF NOT EXISTS processed_mail_events (
  id BIGSERIAL PRIMARY KEY,
  normalized_message_id TEXT NOT NULL UNIQUE,
  original_message_id TEXT NOT NULL,
  task_id BIGINT NOT NULL CHECK (task_id > 0),
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  event_at TIMESTAMPTZ NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('updated', 'manual_review')),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
