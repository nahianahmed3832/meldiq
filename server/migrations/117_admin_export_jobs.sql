-- Temporary operator-owned export artifacts; source records and permanent audit remain authoritative.
CREATE TABLE platform_export_jobs (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  query_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','ready','failed','expired')),
  rows_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL,
  error TEXT,
  filename TEXT,
  csv TEXT,
  UNIQUE (actor_account_id, request_key)
);
CREATE INDEX idx_platform_exports_actor ON platform_export_jobs(actor_account_id, created_at);
CREATE INDEX idx_platform_exports_expiry ON platform_export_jobs(expires_at);
