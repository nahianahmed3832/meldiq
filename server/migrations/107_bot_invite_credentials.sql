-- Token revisions are synchronous denial records, including after bot/owner deletion.
ALTER TABLE bot_installation_permissions ADD COLUMN install_key TEXT NOT NULL DEFAULT '';
UPDATE bot_installation_permissions SET install_key=lower(hex(randomblob(16)));
ALTER TABLE bot_derived_credentials ADD COLUMN install_key TEXT NOT NULL DEFAULT '';
CREATE TABLE bot_credential_revisions (
  bot_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE INDEX bot_credential_owner ON bot_credential_revisions(owner_id, active, created_at, bot_id);
CREATE TABLE bot_invite_credentials (
  invite_id TEXT PRIMARY KEY REFERENCES invitations(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  bot_token_hash TEXT NOT NULL,
  install_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
