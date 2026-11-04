-- Personal bot access is granted by the recipient, separately from community installations.
CREATE TABLE bot_dm_consents (
  bot_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  manifest_rev INTEGER NOT NULL,
  notice_version TEXT NOT NULL,
  rev INTEGER NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY(bot_id,user_id)
);
