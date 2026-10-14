CREATE TABLE contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  contract_number TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  start_date DATE,
  end_date DATE,
  notes TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contract_assignments (
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(contract_id,user_id)
);

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  identity_key TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  lot_number TEXT NOT NULL DEFAULT '',
  asset_number TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','decommissioned')),
  purchased_on DATE,
  decommissioned_on DATE,
  decommission_reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(client_id,identity_key)
);

CREATE TABLE contract_devices (
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  added_on DATE NOT NULL DEFAULT CURRENT_DATE,
  removed_on DATE,
  PRIMARY KEY(contract_id,device_id)
);

CREATE TABLE service_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  title TEXT NOT NULL DEFAULT 'Scheduled service',
  location TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  recommendations TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized')),
  source_report_id UUID UNIQUE REFERENCES reports(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_visit_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_visit_id UUID NOT NULL REFERENCES service_visits(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  source_report_row_id UUID UNIQUE REFERENCES report_rows(id) ON DELETE SET NULL,
  hours_in TEXT NOT NULL DEFAULT '',
  hours_out TEXT NOT NULL DEFAULT '',
  serviced BOOLEAN NOT NULL DEFAULT false,
  comments TEXT NOT NULL DEFAULT '',
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(service_visit_id,device_id)
);

CREATE TABLE fitted_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_visit_device_id UUID NOT NULL REFERENCES service_visit_devices(id) ON DELETE CASCADE,
  part_id UUID REFERENCES spare_parts(id) ON DELETE SET NULL,
  part_number TEXT NOT NULL DEFAULT '',
  part_name TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  fitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  fitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE service_visit_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_visit_id UUID NOT NULL REFERENCES service_visits(id) ON DELETE CASCADE,
  signer_role TEXT NOT NULL CHECK (signer_role IN ('engineer','client')),
  signer_name TEXT NOT NULL,
  signature_data TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(service_visit_id,signer_role)
);

CREATE INDEX contracts_client_idx ON contracts(client_id,status);
CREATE INDEX contract_assignments_user_idx ON contract_assignments(user_id,contract_id);
CREATE INDEX devices_client_idx ON devices(client_id,status);
CREATE INDEX service_visits_contract_date_idx ON service_visits(contract_id,service_date DESC);
CREATE INDEX service_visit_devices_device_idx ON service_visit_devices(device_id,service_visit_id);
CREATE INDEX fitted_parts_service_device_idx ON fitted_parts(service_visit_device_id);

CREATE TRIGGER contracts_updated_at BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER devices_updated_at BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER service_visits_updated_at BEFORE UPDATE ON service_visits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER service_visit_devices_updated_at BEFORE UPDATE ON service_visit_devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO contracts(client_id,name,created_by,created_at)
SELECT c.id,c.name || ' Service Contract',(array_agg(r.uploaded_by ORDER BY r.uploaded_at) FILTER (WHERE r.uploaded_by IS NOT NULL))[1],min(r.uploaded_at)
FROM clients c JOIN reports r ON lower(btrim(r.client_name))=lower(btrim(c.name))
GROUP BY c.id,c.name;

INSERT INTO contract_assignments(contract_id,user_id,assigned_by,assigned_at)
SELECT DISTINCT ct.id,ra.user_id,ra.assigned_by,min(ra.assigned_at) OVER (PARTITION BY ct.id,ra.user_id)
FROM reports r
JOIN LATERAL (
  SELECT candidate.id FROM contracts candidate JOIN clients client ON client.id=candidate.client_id
  WHERE lower(btrim(client.name))=lower(btrim(r.client_name)) ORDER BY candidate.created_at,candidate.id LIMIT 1
) ct ON true
JOIN report_assignments ra ON ra.report_id=r.id
ON CONFLICT DO NOTHING;

INSERT INTO service_visits(contract_id,service_date,title,source_report_id,created_by,created_at)
SELECT ct.id,r.uploaded_at::date,r.original_filename,r.id,r.uploaded_by,r.uploaded_at
FROM reports r
JOIN LATERAL (
  SELECT candidate.id FROM contracts candidate JOIN clients client ON client.id=candidate.client_id
  WHERE lower(btrim(client.name))=lower(btrim(r.client_name)) ORDER BY candidate.created_at,candidate.id LIMIT 1
) ct ON true
ON CONFLICT(source_report_id) DO NOTHING;

INSERT INTO devices(client_id,identity_key,device_name,serial_number,lot_number,asset_number,created_at)
SELECT DISTINCT ON (ct.client_id,identity_key) ct.client_id,identity_key,rr.device_name,rr.serial_number,rr.lot_number,rr.asset_number,rr.created_at
FROM report_rows rr JOIN reports r ON r.id=rr.report_id
JOIN LATERAL (
  SELECT candidate.client_id FROM contracts candidate JOIN clients client ON client.id=candidate.client_id
  WHERE lower(btrim(client.name))=lower(btrim(r.client_name)) ORDER BY candidate.created_at,candidate.id LIMIT 1
) ct ON true
CROSS JOIN LATERAL (SELECT CASE WHEN btrim(rr.serial_number)<>'' THEN 'serial:'||lower(btrim(rr.serial_number)) WHEN btrim(rr.asset_number)<>'' THEN 'asset:'||lower(btrim(rr.asset_number)) ELSE 'row:'||rr.id::text END AS identity_key) key
ORDER BY ct.client_id,identity_key,rr.created_at
ON CONFLICT(client_id,identity_key) DO NOTHING;

INSERT INTO contract_devices(contract_id,device_id,added_on)
SELECT DISTINCT ct.id,d.id,rr.created_at::date
FROM report_rows rr JOIN reports r ON r.id=rr.report_id
JOIN LATERAL (
  SELECT candidate.id,candidate.client_id FROM contracts candidate JOIN clients client ON client.id=candidate.client_id
  WHERE lower(btrim(client.name))=lower(btrim(r.client_name)) ORDER BY candidate.created_at,candidate.id LIMIT 1
) ct ON true
JOIN devices d ON d.client_id=ct.client_id AND d.identity_key=CASE WHEN btrim(rr.serial_number)<>'' THEN 'serial:'||lower(btrim(rr.serial_number)) WHEN btrim(rr.asset_number)<>'' THEN 'asset:'||lower(btrim(rr.asset_number)) ELSE 'row:'||rr.id::text END
ON CONFLICT DO NOTHING;

INSERT INTO service_visit_devices(service_visit_id,device_id,source_report_row_id,hours_in,hours_out,serviced,comments,values,created_at)
SELECT sv.id,d.id,rr.id,rr.hours_in,rr.hours_out,lower(COALESCE(rr.values->>'Serviced','no')) IN ('yes','true','1','checked'),rr.comments,rr.values,rr.created_at
FROM report_rows rr JOIN service_visits sv ON sv.source_report_id=rr.report_id
JOIN contracts ct ON ct.id=sv.contract_id
JOIN devices d ON d.client_id=ct.client_id AND d.identity_key=CASE WHEN btrim(rr.serial_number)<>'' THEN 'serial:'||lower(btrim(rr.serial_number)) WHEN btrim(rr.asset_number)<>'' THEN 'asset:'||lower(btrim(rr.asset_number)) ELSE 'row:'||rr.id::text END
ON CONFLICT DO NOTHING;
