-- 2026-10-30 (community parity A2, docs/COMMUNITY_SAFETY_API.md): a community's safety settings and lock, voice bans
-- and server mutes. Additive: new tables only, so an older server image runs on this schema unchanged (it ignores them).
-- No foreign keys: with MONGODB_DOMAINS=workspace these live in MongoDB beside the communities, and a community's rows
-- go with it explicitly (organizations/safety/service.ts).

-- One row per community that changed a safety setting or was locked; a community without a row has the defaults
-- (verification none, no account-age gate, raid protection on, not locked).
-- verification_level: who may post and react in channels (none | low: verified email | medium: low + account and
-- membership 5 minutes old | high: medium with membership 10 minutes old). new_account_gate: accounts younger than this
-- can't join (off | 10m | 1h | 1d | 7d). raid_protection: lock on a join flood and slow channels down on a message flood.
-- locked_until: while in the future nobody new joins and only moderators post; lock_reason says who locked it (manual:
-- [locked_by], raid: raid protection, locked_by NULL).
CREATE TABLE community_safety (
  org_id              TEXT PRIMARY KEY,
  verification_level  TEXT NOT NULL DEFAULT 'none' CHECK (verification_level IN ('none', 'low', 'medium', 'high')),
  new_account_gate    TEXT NOT NULL DEFAULT 'off' CHECK (new_account_gate IN ('off', '10m', '1h', '1d', '7d')),
  raid_protection     INTEGER NOT NULL DEFAULT 1 CHECK (raid_protection IN (0, 1)),
  locked_until        INTEGER,
  lock_reason         TEXT CHECK (lock_reason IN ('manual', 'raid')),
  locked_by           TEXT,
  updated_at          INTEGER NOT NULL,
  updated_by          TEXT
);

-- Voice bans: kept out of the community's voice channels (they still read and chat). Separate from org_bans.
CREATE TABLE community_voice_bans (
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  reason     TEXT,
  banned_by  TEXT NOT NULL,
  banned_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_community_voice_bans_user ON community_voice_bans(user_id);

-- Server mutes: muted in every voice channel of the community (they listen only) until a moderator unmutes them.
CREATE TABLE community_voice_mutes (
  org_id    TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  muted_by  TEXT NOT NULL,
  muted_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_community_voice_mutes_user ON community_voice_mutes(user_id);
