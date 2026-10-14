INSERT INTO custom_fields (name, kind, position)
VALUES ('Serviced', 'checkbox', 7)
ON CONFLICT (name) DO UPDATE SET kind = 'checkbox', position = EXCLUDED.position, active = true;

UPDATE report_rows
SET values = jsonb_set(values, ARRAY['Serviced'], 'false'::jsonb, true)
WHERE NOT values ? 'Serviced';
