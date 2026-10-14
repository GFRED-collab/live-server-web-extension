ALTER TABLE appointments ADD COLUMN end_date DATE;
UPDATE appointments SET end_date=appointment_date;
ALTER TABLE appointments ALTER COLUMN end_date SET NOT NULL;
ALTER TABLE appointments ADD CONSTRAINT appointments_date_range CHECK(end_date>=appointment_date);
CREATE INDEX appointments_date_range_idx ON appointments(appointment_date,end_date);

ALTER TABLE custom_fields ADD COLUMN source_key TEXT;
UPDATE custom_fields SET source_key=name;
ALTER TABLE custom_fields ALTER COLUMN source_key SET NOT NULL;
ALTER TABLE custom_fields ALTER COLUMN source_key SET DEFAULT gen_random_uuid()::text;
ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_source_key_key UNIQUE(source_key);
