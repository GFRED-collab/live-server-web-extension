ALTER TABLE users ADD COLUMN client_id uuid REFERENCES clients(id) ON DELETE RESTRICT;
ALTER TABLE users ADD CONSTRAINT customer_client_required CHECK (
 (role::text='customer' AND client_id IS NOT NULL) OR (role::text<>'customer' AND client_id IS NULL)
);
CREATE INDEX users_customer_client_idx ON users(client_id) WHERE client_id IS NOT NULL;
