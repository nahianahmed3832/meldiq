-- Additive assurance records keep existing session storage and legacy sessions compatible.
CREATE TABLE account_session_factors (
  id TEXT PRIMARY KEY REFERENCES account_sessions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_session_factors_expiry ON account_session_factors(expires_at);
