-- External locations retain an authorized visibility channel. Current-occurrence overrides preserve the future series template and RSVP state.
ALTER TABLE meetings ADD COLUMN external_location TEXT;
ALTER TABLE meetings ADD COLUMN occurrence_base TEXT CHECK(occurrence_base IS NULL OR json_valid(occurrence_base));
ALTER TABLE meetings ADD COLUMN occurrence_cancelled INTEGER NOT NULL DEFAULT 0 CHECK(occurrence_cancelled IN (0,1));
