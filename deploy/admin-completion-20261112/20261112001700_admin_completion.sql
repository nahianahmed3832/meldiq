-- Reviewed additive candidate. Apply in one transaction after validating the prerequisite schema.
SET LOCAL search_path = meldiq, public;
-- Additive operation ledger. Existing financial history is retained; no amounts are backfilled or inferred.
ALTER TABLE billing_provider_events ADD COLUMN provider_mode TEXT;
ALTER TABLE billing_provider_events ADD COLUMN provider_scope TEXT;
CREATE TABLE billing_admin_refunds (
 id TEXT PRIMARY KEY,
 request_key TEXT NOT NULL UNIQUE,
 provider TEXT NOT NULL,
 provider_mode TEXT NOT NULL CHECK(provider_mode IN ('test','live')),
 merchant_id TEXT NOT NULL,
 purchase_kind TEXT NOT NULL CHECK(purchase_kind IN ('gift','spark','collectible','card')),
 purchase_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 order_ref TEXT NOT NULL,
 payment_ref TEXT NOT NULL,
 currency TEXT NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor > 0),
 captured_minor bigint NOT NULL CHECK(captured_minor > 0),
 baseline_refunded_minor bigint NOT NULL DEFAULT 0,
 actor_account_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','submitting','pending','uncertain','completed','failed')),
 provider_ref TEXT,
 last_error TEXT,
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL
);
CREATE INDEX idx_admin_refunds_payment ON billing_admin_refunds(provider, provider_mode, merchant_id, payment_ref, status);
CREATE INDEX idx_admin_refunds_purchase ON billing_admin_refunds(purchase_id, created_at, id);
CREATE INDEX idx_admin_refunds_queue ON billing_admin_refunds(status, created_at, id);

-- New mandates retain their source environment; historical NULL is intentionally not inferred.
ALTER TABLE billing_card_mandates ADD COLUMN provider_mode TEXT;
ALTER TABLE billing_card_mandates ADD COLUMN merchant_id TEXT;

-- Authoritative attribution on new financial records only. Never infer historical mode from today's credentials.
ALTER TABLE billing_subscriptions ADD COLUMN provider_mode TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN provider_scope TEXT;
ALTER TABLE billing_invoices ADD COLUMN provider_mode TEXT;
ALTER TABLE billing_invoices ADD COLUMN provider_scope TEXT;
CREATE INDEX idx_billing_subscriptions_mode ON billing_subscriptions(provider_mode, provider, status);
CREATE INDEX idx_billing_invoices_mode ON billing_invoices(provider_mode, provider, issued_at);

-- Additive indexes for provider/currency reporting and stable filtered webhook drill-downs.
CREATE INDEX IF NOT EXISTS idx_billing_events_provider_status_received ON billing_provider_events(provider, status, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_provider_currency_paid ON billing_invoices(provider, currency, paid_at);
CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_provider_created ON billing_subscriptions(provider, created_at);

-- Platform support cases remain operational metadata only. Native user contracts are unchanged.
ALTER TABLE platform_incidents ADD COLUMN version bigint NOT NULL DEFAULT 0;
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
  created_at bigint NOT NULL,
  PRIMARY KEY (actor_account_id, request_key)
);
CREATE INDEX idx_platform_incident_requests_incident ON platform_incident_requests(incident_id);
CREATE TABLE platform_recovery_runs (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at bigint NOT NULL,
  completed_at bigint,
  affected bigint,
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
  expected_at bigint NOT NULL,
  apply_at bigint NOT NULL,
  desired_status TEXT NOT NULL,
  created_at bigint NOT NULL,
  completed_at bigint,
  UNIQUE(actor_account_id, request_key)
);
CREATE INDEX idx_platform_feedback_reviews_target ON platform_feedback_reviews(feedback_id, created_at, id);

-- Temporary operator-owned export artifacts; source records and permanent audit remain authoritative.
CREATE TABLE platform_export_jobs (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  query_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','ready','failed','expired')),
  rows_count bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  started_at bigint,
  completed_at bigint,
  expires_at bigint NOT NULL,
  error TEXT,
  filename TEXT,
  csv TEXT,
  UNIQUE (actor_account_id, request_key)
);
CREATE INDEX idx_platform_exports_actor ON platform_export_jobs(actor_account_id, created_at);
CREATE INDEX idx_platform_exports_expiry ON platform_export_jobs(expires_at);

ALTER TABLE billing_admin_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_admin_refunds FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_admin_refunds FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_admin_refunds TO meldiq_api;
CREATE POLICY trusted_backend ON billing_admin_refunds FOR ALL TO meldiq_api USING (true) WITH CHECK (true);
ALTER TABLE platform_incident_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_incident_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_incident_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_incident_requests TO meldiq_api;
CREATE POLICY trusted_backend ON platform_incident_requests FOR ALL TO meldiq_api USING (true) WITH CHECK (true);
ALTER TABLE platform_recovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_recovery_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_recovery_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_recovery_runs TO meldiq_api;
CREATE POLICY trusted_backend ON platform_recovery_runs FOR ALL TO meldiq_api USING (true) WITH CHECK (true);
ALTER TABLE platform_feedback_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_feedback_reviews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_feedback_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_feedback_reviews TO meldiq_api;
CREATE POLICY trusted_backend ON platform_feedback_reviews FOR ALL TO meldiq_api USING (true) WITH CHECK (true);
ALTER TABLE platform_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_export_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_export_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_export_jobs TO meldiq_api;
CREATE POLICY trusted_backend ON platform_export_jobs FOR ALL TO meldiq_api USING (true) WITH CHECK (true);
