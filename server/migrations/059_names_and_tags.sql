-- 2026-10-28 (API 0.46.0, docs/PROFILE_MEDIA.md › Name styles and community tags). Additive only: one nullable column.
-- A community's tag: 2 to 4 letters or digits its members may wear next to their names (Settings › Profile), or NULL
-- without one. Name styles live in users.profile_style (JSON text since 058), so they need no column.
ALTER TABLE orgs ADD COLUMN tag TEXT;
