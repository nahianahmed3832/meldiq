-- 2026-10-30 (community parity B, docs/COMMUNITY_PARITY_API.md › Lobby): a community's lobby, the home page members
-- land on. New tables only; existing ones are untouched, and a community without a row here shows the default lobby.

-- One row per community whose lobby was ever saved: everything the editor sets, as JSON (about, main channels, FAQ,
-- buttons, look, sections, leaderboards), and a revision that goes up with every save (optimistic concurrency).
CREATE TABLE community_lobbies (
  org_id      TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  settings    TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL
);

-- The lobby's incoming feed URL: one per community. Only the token's SHA-256 is kept (the URL is shown once).
CREATE TABLE community_lobby_feeds (
  org_id        TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  last_post_at  INTEGER
);

-- Posts that came in through the feed URL; the newest 20 per community are kept.
CREATE TABLE community_lobby_posts (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  title      TEXT,
  text       TEXT,
  url        TEXT,
  image      TEXT,
  posted_at  INTEGER NOT NULL
);
CREATE INDEX idx_community_lobby_posts_org ON community_lobby_posts (org_id, posted_at);

-- When each member first saw the lobby (apps open it first only until then). Goes when they leave.
CREATE TABLE community_lobby_seen (
  org_id   TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  seen_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_community_lobby_seen_user ON community_lobby_seen (user_id);
