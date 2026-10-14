CREATE TABLE service_status_options (
  name TEXT PRIMARY KEY CHECK(char_length(name) BETWEEN 1 AND 80),
  position INTEGER NOT NULL DEFAULT 0
);
INSERT INTO service_status_options(name,position) VALUES ('Not serviced',0),('Serviced',1),('Follow-up required',2);
ALTER TABLE service_visit_devices ADD COLUMN service_status TEXT NOT NULL DEFAULT 'Not serviced';
UPDATE service_visit_devices SET service_status=CASE WHEN serviced THEN 'Serviced' ELSE 'Not serviced' END;
UPDATE custom_fields SET active=false WHERE source_key IN ('Amount in Hours','Amount out of Hours');
UPDATE custom_fields SET name='Service status',kind='text',active=true WHERE source_key='Serviced';
INSERT INTO custom_fields(name,kind,source_key,position)
SELECT 'Service status','text','Serviced',COALESCE((SELECT max(position)+1 FROM custom_fields),0)
WHERE NOT EXISTS(SELECT 1 FROM custom_fields WHERE source_key='Serviced');
UPDATE report_rows SET values=jsonb_set(values,ARRAY['Serviced'],to_jsonb(CASE WHEN lower(COALESCE(values->>'Serviced','')) IN ('true','yes','1','checked','serviced') THEN 'Serviced' WHEN lower(COALESCE(values->>'Serviced','')) IN ('','false','no','0','not serviced') THEN 'Not serviced' ELSE values->>'Serviced' END),true);
