CREATE TABLE callouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','closed')),
  assigned_user_id UUID NOT NULL REFERENCES users(id),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX callouts_assignment_status ON callouts(assigned_user_id,status);
CREATE TRIGGER callouts_updated_at BEFORE UPDATE ON callouts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dockets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  callout_id UUID REFERENCES callouts(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  work_description TEXT NOT NULL,
  engineer_name TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  signer_role TEXT NOT NULL CHECK(signer_role IN ('engineer','client')),
  signature_data TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX dockets_creator_date ON dockets(created_by,signed_at DESC);
