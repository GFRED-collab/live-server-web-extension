UPDATE custom_fields
SET active = false
WHERE lower(btrim(name)) = 'whitfield';
