-- Reviewed additive candidate. Apply in one transaction after validating the prerequisite schema.
SET LOCAL search_path = meldiq, public;
CREATE TABLE community_ping_roles (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  rev bigint NOT NULL,
  roles TEXT NOT NULL
);

CREATE TABLE community_ping_subscriptions (
  org_id TEXT NOT NULL REFERENCES community_ping_roles(org_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id, role_id)
);

CREATE INDEX idx_ping_subscriptions_role ON community_ping_subscriptions(org_id, role_id);

ALTER TABLE community_settings ADD COLUMN voice_clips bigint NOT NULL DEFAULT 0 CHECK (voice_clips IN (0, 1));

ALTER TABLE community_ping_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_ping_roles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON community_ping_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON community_ping_roles TO meldiq_api;
CREATE POLICY trusted_backend ON community_ping_roles FOR ALL TO meldiq_api USING (true) WITH CHECK (true);
ALTER TABLE community_ping_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_ping_subscriptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON community_ping_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON community_ping_subscriptions TO meldiq_api;
CREATE POLICY trusted_backend ON community_ping_subscriptions FOR ALL TO meldiq_api USING (true) WITH CHECK (true);
