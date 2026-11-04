-- Retain the binding when a bot is deleted, so its old webhook cannot become an unbound human credential.
CREATE TABLE bot_derived_credentials (
  credential_id TEXT PRIMARY KEY REFERENCES channel_webhooks(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  bot_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
