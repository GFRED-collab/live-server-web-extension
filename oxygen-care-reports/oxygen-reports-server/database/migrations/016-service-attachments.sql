CREATE TABLE service_attachments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 service_visit_id uuid NOT NULL REFERENCES service_visits(id) ON DELETE RESTRICT,
 device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
 filename text NOT NULL,
 content_type text NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 5242880),
 uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
 uploaded_at timestamptz NOT NULL DEFAULT now(),
 removed_at timestamptz,
 removed_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX service_attachments_visit_device_idx ON service_attachments(service_visit_id,device_id);
