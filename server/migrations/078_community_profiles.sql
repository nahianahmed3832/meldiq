-- Community identity choices follow membership and never alter the global profile.
CREATE TABLE community_profiles (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id,user_id),
  FOREIGN KEY (org_id,user_id) REFERENCES org_members(org_id,user_id) ON DELETE CASCADE
);
