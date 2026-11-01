-- Additive only: no existing account, password, session or application data changes.
CREATE TABLE account_social_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('google','apple','discord')),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  connected_at INTEGER NOT NULL,
  UNIQUE(provider, issuer, subject),
  UNIQUE(account_id, provider)
);
CREATE TABLE account_social_flows (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  stage TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX account_social_flows_expiry ON account_social_flows(expires_at);
