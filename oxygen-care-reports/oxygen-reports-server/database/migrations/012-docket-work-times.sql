ALTER TABLE dockets ADD COLUMN started_at TIMESTAMPTZ;
ALTER TABLE dockets ADD COLUMN ended_at TIMESTAMPTZ;
ALTER TABLE dockets ADD CONSTRAINT dockets_work_time_range CHECK (
  (started_at IS NULL AND ended_at IS NULL) OR
  (started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at>=started_at)
);
