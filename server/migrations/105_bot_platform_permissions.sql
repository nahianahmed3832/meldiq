-- Advanced bot permissions are opt-in per installation. Existing bots keep their existing API only.
CREATE TABLE bot_requested_permissions (
  bot_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT NOT NULL DEFAULT '[]',
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE bot_installation_permissions (
  org_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  manifest_rev INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, bot_id),
  FOREIGN KEY (org_id, bot_id) REFERENCES org_members(org_id, user_id) ON DELETE CASCADE
);
