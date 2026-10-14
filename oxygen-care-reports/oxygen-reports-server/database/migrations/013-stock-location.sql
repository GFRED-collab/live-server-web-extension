ALTER TABLE spare_parts ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE spare_parts ADD CONSTRAINT spare_parts_location_length CHECK (char_length(location) <= 160);
