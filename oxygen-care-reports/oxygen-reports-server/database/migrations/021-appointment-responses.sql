-- An appointment a Super User assigns to an engineer waits for the engineer to accept or reject
-- it. 'none' covers unassigned appointments and those people add for themselves.
ALTER TABLE appointments
  ADD COLUMN response_status TEXT NOT NULL DEFAULT 'none'
    CHECK (response_status IN ('none','pending','accepted','rejected')),
  ADD COLUMN response_note TEXT NOT NULL DEFAULT '' CHECK (length(response_note) <= 1000),
  ADD COLUMN responded_at TIMESTAMPTZ,
  ADD CONSTRAINT appointments_rejection_reason
    CHECK (response_status <> 'rejected' OR length(btrim(response_note)) > 0);
CREATE INDEX appointments_response_idx ON appointments(response_status, assigned_user_id)
  WHERE response_status IN ('pending','rejected');
