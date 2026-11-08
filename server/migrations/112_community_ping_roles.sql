CREATE TABLE community_ping_roles (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  roles TEXT NOT NULL
);

CREATE TABLE community_ping_subscriptions (
  org_id TEXT NOT NULL REFERENCES community_ping_roles(org_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id, role_id)
);

CREATE INDEX idx_ping_subscriptions_role ON community_ping_subscriptions(org_id, role_id);
