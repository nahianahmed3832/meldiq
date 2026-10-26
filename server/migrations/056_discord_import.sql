-- 2026-10-27: importing a Discord server's structure into a Meldiq community (docs/DISCORD_IMPORT.md). Additive only:
-- four new tables, nothing existing changes. No Discord token is stored anywhere: the user's OAuth token is used once
-- to confirm they manage the server and then revoked; the bot token lives only in the server's environment.

-- One sign-in with Discord in progress: the random state's hash, bound to the Meldiq account that started it (10 minutes).
CREATE TABLE discord_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_discord_oauth_states_expiry ON discord_oauth_states(expires_at);

-- A Discord server the account proved it manages and the bot was added to (usable for 24 hours, or until disconnected).
CREATE TABLE discord_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  guild_name TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_discord_connections_user ON discord_connections(user_id, expires_at);

-- One import: what was chosen, where it goes, and how far it got. org_id is set once the destination exists, so a retry
-- never creates a second community.
CREATE TABLE discord_imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  guild_name TEXT NOT NULL,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  new_name TEXT,
  options TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_discord_imports_user ON discord_imports(user_id, created_at);

-- One planned item (the server icon, a role, a category, a channel, an emoji): its structure only, never messages or
-- members. source_key is the Discord object ("channel:123"); target_id the Meldiq object once made.
CREATE TABLE discord_import_items (
  import_id TEXT NOT NULL REFERENCES discord_imports(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  target_id TEXT,
  note TEXT,
  PRIMARY KEY (import_id, source_key)
);
