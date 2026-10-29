-- 2026-10-30 (community parity batch D part 1, official bots; docs/COMMUNITY_PARITY_API.md › Official bots). New tables
-- only, in the workspace domain (new MongoDB collections when it lives there), so older images ignore them and
-- production's readWrite-only user never needs collMod. Each goes with its community.
--
-- official_bots:      a community's official bots (Welcomer, Helper, Levels, Logger, Starboard...): on or off, their
--                     settings (JSON, checked by the server) and their look in this community. user_id is the bot's
--                     hidden account for this community (users.kind 'agent'): a member of the community while the bot
--                     is on, kept when it's off so its messages keep a name.
-- official_bots_plus: Bots+ for a community (every official bot's Plus extras), granted by platform admins while
--                     billing for it is off; expires_at null: no end.
-- bot_levels:         the Levels bot's XP per member and when they last earned some (at most once a minute).
-- bot_afk:            Helper's "!afk": who is away, why, since when, and who has been told already (JSON ids).
-- bot_starboard:      messages the Starboard bot copied (once each), where the copy is and the stars it counted.

CREATE TABLE official_bots (
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  bot_key     TEXT NOT NULL,
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  settings    TEXT NOT NULL,
  look_name   TEXT,
  user_id     TEXT,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, bot_key)
);
CREATE INDEX idx_official_bots_user ON official_bots (user_id);

CREATE TABLE official_bots_plus (
  org_id      TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  granted_by  TEXT NOT NULL,
  granted_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  reason      TEXT NOT NULL
);

CREATE TABLE bot_levels (
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  xp          INTEGER NOT NULL,
  last_xp_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_bot_levels_xp ON bot_levels (org_id, xp);
CREATE INDEX idx_bot_levels_user ON bot_levels (user_id);

CREATE TABLE bot_afk (
  org_id    TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL,
  reason    TEXT NOT NULL,
  since     INTEGER NOT NULL,
  notified  TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_bot_afk_user ON bot_afk (user_id);

CREATE TABLE bot_starboard (
  message_id       TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  star_channel_id  TEXT NOT NULL,
  star_message_id  TEXT,
  stars            INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_bot_starboard_org ON bot_starboard (org_id);
