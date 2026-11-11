-- Platform support cases remain operational metadata only. Native user contracts are unchanged.
ALTER TABLE platform_incidents ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_incidents ADD COLUMN account_ref TEXT;
ALTER TABLE platform_incidents ADD COLUMN subscription_ref TEXT;
ALTER TABLE platform_incidents ADD COLUMN payment_kind TEXT CHECK (payment_kind IN ('invoice', 'gift', 'spark', 'collectible'));
ALTER TABLE platform_incidents ADD COLUMN payment_ref TEXT;
CREATE INDEX idx_platform_incidents_page ON platform_incidents(created_at, id);
CREATE INDEX idx_platform_incidents_account_page ON platform_incidents(account_ref, created_at, id);
CREATE INDEX idx_platform_incidents_subscription ON platform_incidents(subscription_ref, created_at, id);
CREATE INDEX idx_platform_incidents_payment ON platform_incidents(payment_kind, payment_ref, created_at, id);
CREATE INDEX idx_platform_incidents_assignment ON platform_incidents(assignee_account_id, created_at, id);
CREATE TABLE platform_incident_requests (
  actor_account_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'note')),
  payload_hash TEXT NOT NULL,
  incident_id TEXT NOT NULL REFERENCES platform_incidents(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_account_id, request_key)
);
CREATE INDEX idx_platform_incident_requests_incident ON platform_incident_requests(incident_id);
CREATE TABLE platform_recovery_runs (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  affected INTEGER,
  error_kind TEXT,
  UNIQUE(actor_account_id, request_key)
);
CREATE INDEX idx_platform_recovery_runs_time ON platform_recovery_runs(started_at, id);
ALTER TABLE platform_incidents ADD COLUMN intake_ref TEXT;
CREATE UNIQUE INDEX idx_platform_incidents_intake ON platform_incidents(intake_ref) WHERE intake_ref IS NOT NULL;
CREATE TABLE platform_feedback_reviews (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested', 'applied', 'failed')),
  expected_at INTEGER NOT NULL,
  apply_at INTEGER NOT NULL,
  desired_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(actor_account_id, request_key)
);
CREATE INDEX idx_platform_feedback_reviews_target ON platform_feedback_reviews(feedback_id, created_at, id);
