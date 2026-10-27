-- 2026-10-27: richer profiles (docs/PROFILE_MEDIA.md). Additive only: three nullable columns, so every existing profile
-- looks as before until its owner adds something.

-- An animated avatar beside the photo: {"kind":"gif"|"webp"|"video","rev":<n>} (a video has a poster frame too).
ALTER TABLE users ADD COLUMN avatar_media TEXT;
-- A profile banner: {"kind":"jpeg"|"gif"|"webp","rev":<n>}.
ALTER TABLE users ADD COLUMN profile_banner TEXT;
-- Profile style: {"decoration":<id>|null,"effect":<id>|null,"accent":"#rrggbb"|null}, ids from a fixed list.
ALTER TABLE users ADD COLUMN profile_style TEXT;
