-- Optional forum policy; existing forums retain optional tags and existing posts remain readable.
ALTER TABLE conversations ADD COLUMN forum_require_tag INTEGER NOT NULL DEFAULT 0 CHECK(forum_require_tag IN (0,1));
