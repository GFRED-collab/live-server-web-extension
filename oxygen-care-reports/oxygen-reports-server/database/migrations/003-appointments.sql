CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_date DATE NOT NULL,
  start_time TIME,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  client_name TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX appointments_date_idx ON appointments(appointment_date, start_time);
CREATE INDEX appointments_assigned_user_idx ON appointments(assigned_user_id, appointment_date);
CREATE TRIGGER appointments_updated_at BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
