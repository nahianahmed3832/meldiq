ALTER TABLE community_settings ADD COLUMN voice_clips INTEGER NOT NULL DEFAULT 0 CHECK (voice_clips IN (0, 1));
