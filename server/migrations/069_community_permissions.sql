-- 2026-10-30 (community parity A1, feature "community-permissions", docs/COMMUNITY_PERMISSIONS.md): what plain members
-- may do by default, per-community nicknames, role display extras and auto-assignment, channel options and stage
-- speakers. Additive: only new tables (new MongoDB collections when the workspace domain lives there), so production's
-- readWrite-only user never needs collMod, and older images ignore them.

-- A community's own "@everyone" defaults: the everyday (non-administrative) permissions plain members hold, kept as
-- changes to the catalog's Member base set so a power a later server adds there reaches members too. No row: the base set.
CREATE TABLE community_member_defaults (
  org_id      TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  added       TEXT NOT NULL,           -- JSON array of permission keys members hold beyond the base set
  removed     TEXT NOT NULL,           -- JSON array of base-set keys members don't hold here
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- A member's nickname in one community (shown there instead of their display name). Goes with the membership.
CREATE TABLE org_nicknames (
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  nickname   TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES org_members(org_id, user_id) ON DELETE CASCADE
);

-- What a custom role adds beyond org_roles: a second colour (a gradient), whether anyone may mention it, and who gets
-- it automatically (nobody, everyone, or everyone who joined before a time). Auto roles carry no permissions.
CREATE TABLE org_role_extras (
  role_id     TEXT PRIMARY KEY REFERENCES org_roles(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL,
  color2      TEXT,                    -- "#RRGGBB", or NULL for a single colour
  mentionable INTEGER NOT NULL DEFAULT 0 CHECK (mentionable IN (0, 1)),
  auto_assign TEXT NOT NULL DEFAULT 'none' CHECK (auto_assign IN ('none', 'everyone', 'joined_before')),
  auto_before INTEGER,                 -- joined_before: members who joined before this time
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK ((auto_assign = 'joined_before') = (auto_before IS NOT NULL))
);
CREATE INDEX org_role_extras_org ON org_role_extras (org_id);

-- A community channel's options: text only (no files, GIFs or stickers), no GIFs, a stage (voice: listeners until a
-- moderator lets them speak), and read-only (only the listed roles and managers post; everyone reads and reacts).
CREATE TABLE channel_options (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  text_only       INTEGER NOT NULL DEFAULT 0 CHECK (text_only IN (0, 1)),
  no_gifs         INTEGER NOT NULL DEFAULT 0 CHECK (no_gifs IN (0, 1)),
  stage           INTEGER NOT NULL DEFAULT 0 CHECK (stage IN (0, 1)),
  read_only       INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  poster_role_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of custom role ids who may post in a read-only channel
  updated_by      TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX channel_options_org ON channel_options (org_id);

-- People a stage's moderators let speak. Goes when they leave the channel.
CREATE TABLE stage_speakers (
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  granted_by      TEXT NOT NULL,
  granted_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversation_members(conversation_id, user_id) ON DELETE CASCADE
);
