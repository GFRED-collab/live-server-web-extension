CREATE TABLE admin_entry_history (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 entity_type TEXT NOT NULL,
 entity_id UUID NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('updated','deleted')),
 reason TEXT NOT NULL,
 snapshot JSONB NOT NULL,
 actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_entry_history_entity ON admin_entry_history(entity_type,entity_id,recorded_at DESC);
ALTER TABLE dockets ADD COLUMN correction_pending BOOLEAN NOT NULL DEFAULT false;
