CREATE SEQUENCE repair_entry_number_seq;

CREATE TABLE repair_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number TEXT NOT NULL UNIQUE,
  received_date DATE NOT NULL DEFAULT current_date,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 160),
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  asset_number TEXT NOT NULL DEFAULT '',
  reported_fault TEXT NOT NULL,
  condition_received TEXT NOT NULL DEFAULT '',
  work_carried_out TEXT NOT NULL DEFAULT '',
  parts_used TEXT NOT NULL DEFAULT '',
  follow_up_work TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','diagnosing','awaiting_parts','in_progress','follow_up','completed','returned')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  engineer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  engineer_name TEXT NOT NULL DEFAULT '',
  completed_date DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX repair_entries_received_date_idx ON repair_entries(received_date DESC);
CREATE INDEX repair_entries_status_idx ON repair_entries(status);
CREATE INDEX repair_entries_serial_number_idx ON repair_entries(serial_number);
CREATE TRIGGER repair_entries_updated_at BEFORE UPDATE ON repair_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
