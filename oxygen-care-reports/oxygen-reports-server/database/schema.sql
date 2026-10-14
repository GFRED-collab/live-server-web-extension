CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE account_role AS ENUM ('super_user', 'department_head', 'department_user', 'engineer', 'warehouse_user');
CREATE TYPE field_kind AS ENUM ('text', 'checkbox', 'comments');
CREATE TYPE activity_kind AS ENUM ('created', 'updated', 'deleted', 'uploaded', 'exported', 'assigned', 'fitted', 'signed_in', 'password_reset');

CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  role account_role NOT NULL DEFAULT 'department_user',
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  password_hash TEXT NOT NULL,
  mfa_secret_encrypted BYTEA,
  mfa_enabled_at TIMESTAMPTZ,
  can_export BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 80),
  kind field_kind NOT NULL DEFAULT 'text',
  position INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_field_access (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_id UUID NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  can_read BOOLEAN NOT NULL DEFAULT true,
  can_write BOOLEAN NOT NULL DEFAULT false,
  can_export BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, field_id)
);

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 160),
  original_filename TEXT NOT NULL,
  storage_key TEXT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report_assignments (
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);

CREATE TABLE report_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  lot_number TEXT NOT NULL DEFAULT '',
  asset_number TEXT NOT NULL DEFAULT '',
  hours_in TEXT NOT NULL DEFAULT '',
  hours_out TEXT NOT NULL DEFAULT '',
  comments TEXT NOT NULL DEFAULT '',
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE spare_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  warehouse_quantity INTEGER NOT NULL DEFAULT 0 CHECK (warehouse_quantity >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE engineer_stock (
  engineer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  part_id UUID NOT NULL REFERENCES spare_parts(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (engineer_id, part_id)
);

CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id UUID NOT NULL REFERENCES spare_parts(id) ON DELETE RESTRICT,
  engineer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  movement TEXT NOT NULL CHECK (movement IN ('assigned', 'fitted')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  kind activity_kind NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX users_department_idx ON users(department_id);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX report_rows_report_idx ON report_rows(report_id);
CREATE INDEX stock_movements_engineer_idx ON stock_movements(engineer_id, created_at DESC);
CREATE INDEX activity_log_created_idx ON activity_log(created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER report_rows_updated_at BEFORE UPDATE ON report_rows FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER spare_parts_updated_at BEFORE UPDATE ON spare_parts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
