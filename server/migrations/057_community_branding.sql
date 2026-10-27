-- 2026-10-27: a community's own look (docs/COMMUNITY_BRANDING.md). Additive only: two nullable columns, so every
-- existing community keeps Meldiq's standard theme until someone who can edit it picks an accent or adds a banner.

-- The accent colour, "#rrggbb" in lower case, or NULL for Meldiq's theme.
ALTER TABLE orgs ADD COLUMN accent TEXT;

-- The banner's revision (a JPEG in the profile-photos store as "<orgId>_banner-<rev>"), or NULL without one.
ALTER TABLE orgs ADD COLUMN banner_rev INTEGER;
