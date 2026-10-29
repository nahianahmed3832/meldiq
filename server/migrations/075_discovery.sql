-- 2026-10-30 (community parity batch E, discovery; docs/COMMUNITY_PARITY_API.md › Discovery). New tables only, in the
-- workspace domain (new MongoDB collections when it lives there), so older images ignore them and production's
-- readWrite-only user never needs collMod. A community's rows go with the community.
--
-- community_discovery:  how a community shows in Discovery. No row: public communities are listed (once they have
--                       enough members), with the community's own description and no tags. removed_at and official are
--                       set by platform staff only (the console), never by the community.
-- community_templates:  a template made from a community (one per community): its channels, categories, roles and
--                       @everyone defaults as JSON, and the share code that makes a new community from it.
-- bot_listings:         a developer bot its owner put in the community bot directory, with a category and a short
--                       description. A bot that's gone or private again is left out when the directory is read.
-- discovery_boosts:     a paid (or staff-granted) Discovery boost for a time: boost, super or mega. Only the biggest
--                       active one counts. state 'pending' is a checkout that hasn't been paid (unused while billing is
--                       off), 'cancelled' one that was stopped early.
-- promoted_bookings:    a spot in the Promoted row for one week (Monday 00:00 UTC to the next), 4 spots a week, with the
--                       views, clicks and joins Discover recorded while it ran.
-- discovery_visits:     who opened Discover on which UTC day (one row each), for the weekly visitors estimate. Kept 14
--                       days; goes with the account.
-- discovery_clicks:     the last time someone opened a community from Discover, to tell joins that came from it. Goes
--                       with the community and the account.

CREATE TABLE community_discovery (
  org_id          TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  discoverable    INTEGER NOT NULL DEFAULT 1 CHECK (discoverable IN (0, 1)),
  blurb           TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  removed_at      INTEGER,
  removed_reason  TEXT,
  official        INTEGER NOT NULL DEFAULT 0 CHECK (official IN (0, 1)),
  updated_by      TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE community_templates (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL UNIQUE REFERENCES orgs (id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  snapshot    TEXT NOT NULL,
  uses        INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE bot_listings (
  bot_id       TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  listed       INTEGER NOT NULL CHECK (listed IN (0, 1)),
  category     TEXT NOT NULL CHECK (category IN ('moderation', 'fun', 'games', 'utility', 'music', 'economy', 'social', 'ai', 'other')),
  description  TEXT NOT NULL,
  listed_at    INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_bot_listings_listed ON bot_listings (listed);

CREATE TABLE discovery_boosts (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  tier         TEXT NOT NULL CHECK (tier IN ('boost', 'super', 'mega')),
  state        TEXT NOT NULL CHECK (state IN ('pending', 'active', 'cancelled')),
  source       TEXT NOT NULL CHECK (source IN ('grant', 'purchase')),
  price_cents  INTEGER NOT NULL,
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  note         TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_discovery_boosts_org ON discovery_boosts (org_id);
CREATE INDEX idx_discovery_boosts_ends ON discovery_boosts (ends_at);

CREATE TABLE promoted_bookings (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  week_start   INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'active', 'cancelled')),
  source       TEXT NOT NULL CHECK (source IN ('grant', 'purchase')),
  price_cents  INTEGER NOT NULL,
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  views        INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  joins        INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_promoted_bookings_week ON promoted_bookings (week_start);
CREATE INDEX idx_promoted_bookings_org ON promoted_bookings (org_id);

CREATE TABLE discovery_visits (
  day      TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  PRIMARY KEY (day, user_id)
);
CREATE INDEX idx_discovery_visits_user ON discovery_visits (user_id);

CREATE TABLE discovery_clicks (
  org_id   TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_discovery_clicks_user ON discovery_clicks (user_id);
