INSERT INTO custom_fields (name, kind, position)
VALUES
  ('Device/Machine Name', 'text', 0),
  ('Serial Number', 'text', 1),
  ('Lot Number', 'text', 2),
  ('Asset Number', 'text', 3),
  ('Amount in Hours', 'text', 4),
  ('Amount out of Hours', 'text', 5),
  ('Comments', 'comments', 6)
ON CONFLICT (name) DO UPDATE SET position = EXCLUDED.position, active = true;
