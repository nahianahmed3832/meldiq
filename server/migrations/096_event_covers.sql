-- One event cover, held in the existing image blob store and gated by current room access.
ALTER TABLE meetings ADD COLUMN cover_id TEXT;
