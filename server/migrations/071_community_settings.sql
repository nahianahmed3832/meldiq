-- 2026-10-30 (community parity A3, docs/COMMUNITY_SETTINGS_API.md): a community's settings that came with the reference
-- app's Server Profile, Theme and Onboarding pages. New tables only; existing ones are untouched, and a community
-- without a row here keeps today's behaviour.

-- One row per community that changed any of these: its background tint ("#rrggbb" in lower case, or NULL), its links
-- (JSON [{label, url}], at most five), and onboarding's "must finish before chatting" with the moment it was last turned
-- on (members who joined before then are never held back) and the channel people land in when they finish.
CREATE TABLE community_settings (
  org_id                    TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  background                TEXT,
  links                     TEXT NOT NULL DEFAULT '[]',
  onboarding_required       INTEGER NOT NULL DEFAULT 0,
  onboarding_required_since INTEGER,
  start_channel_id          TEXT,
  updated_at                INTEGER NOT NULL,
  updated_by                TEXT NOT NULL
);

-- A community's custom invite link (meldiq.app/invite/<slug>): one per community, unique ignoring case. It joins through
-- an ordinary invitation that never expires and has no use limit, so every join rule applies; clearing it revokes that.
CREATE TABLE community_vanity_invites (
  slug       TEXT PRIMARY KEY COLLATE NOCASE,
  org_id     TEXT NOT NULL UNIQUE REFERENCES orgs (id) ON DELETE CASCADE,
  invite_id  TEXT NOT NULL REFERENCES invitations (id) ON DELETE CASCADE,
  claimed_by TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);

-- Each member's standard invite link (the one the invite dialog shows): never expires, no use limit. Its code is kept
-- so the dialog can show the same link again; the invitation itself is an ordinary one.
CREATE TABLE community_standard_invites (
  org_id    TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL,
  invite_id TEXT NOT NULL REFERENCES invitations (id) ON DELETE CASCADE,
  code      TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_community_standard_invites_user ON community_standard_invites (user_id);

-- When each member last finished onboarding (finishing again moves it). Goes when they leave.
CREATE TABLE onboarding_completions (
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  finished_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_onboarding_completions_user ON onboarding_completions (user_id);
