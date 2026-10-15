-- Customer callout requests. A request is reviewed by a Super User, who either declines it
-- or accepts it by creating a normal callout with an engineer assigned.
CREATE TABLE callout_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent')),
  location TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 300),
  contact_name TEXT NOT NULL DEFAULT '' CHECK (length(contact_name) <= 200),
  contact_phone TEXT NOT NULL DEFAULT '' CHECK (length(contact_phone) <= 50),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','declined')),
  decline_reason TEXT NOT NULL DEFAULT '' CHECK (length(decline_reason) <= 1000),
  callout_id UUID REFERENCES callouts(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- callout_id is not required once accepted: deleting the callout later clears it.
  CHECK ((status = 'new') = (decided_at IS NULL))
);
CREATE INDEX callout_requests_client_idx ON callout_requests(client_id, created_at DESC);
CREATE INDEX callout_requests_status_idx ON callout_requests(status, created_at);
CREATE TRIGGER callout_requests_updated_at BEFORE UPDATE ON callout_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
