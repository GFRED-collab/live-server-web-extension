ALTER TABLE reports ADD COLUMN service_visit_id uuid REFERENCES service_visits(id) ON DELETE RESTRICT;
UPDATE reports r SET service_visit_id=v.id FROM service_visits v WHERE v.source_report_id=r.id;
CREATE INDEX reports_service_visit_idx ON reports(service_visit_id);
