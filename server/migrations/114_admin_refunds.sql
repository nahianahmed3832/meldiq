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
 amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
 captured_minor INTEGER NOT NULL CHECK(captured_minor > 0),
 baseline_refunded_minor INTEGER NOT NULL DEFAULT 0,
 actor_account_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','submitting','pending','uncertain','completed','failed')),
 provider_ref TEXT,
 last_error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
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
