-- Additional payment capabilities; existing purchases/subscriptions/grants remain unchanged.
CREATE TABLE billing_card_setups (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request_key TEXT NOT NULL, provider TEXT NOT NULL,
 provider_ref TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 completed_at INTEGER, payment_method_id TEXT, UNIQUE(account_id, request_key), UNIQUE(provider, provider_ref)
);
CREATE TABLE billing_payment_methods (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL, token_encrypted TEXT NOT NULL,
 customer_encrypted TEXT NOT NULL, brand TEXT NOT NULL, last_four TEXT NOT NULL, expiry TEXT,
 status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_payment_methods_owner ON billing_payment_methods(account_id, status);
CREATE TABLE billing_card_mandates (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, org_id TEXT, user_id TEXT, payment_method_id TEXT NOT NULL,
 plan_version_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', currency TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0), interval_months INTEGER NOT NULL DEFAULT 1,
 consent_version TEXT NOT NULL, consent_at INTEGER NOT NULL, consent_request_id TEXT NOT NULL,
 billing_anchor_at INTEGER NOT NULL, cycle_index INTEGER NOT NULL DEFAULT 0,
 next_billing_at INTEGER NOT NULL, paid_through INTEGER, cancel_at INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(account_id, consent_request_id)
);
CREATE INDEX idx_card_mandates_due ON billing_card_mandates(status, next_billing_at);
CREATE TABLE billing_card_charges (
 id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', generation INTEGER NOT NULL DEFAULT 0, request_started_at INTEGER, provider_order_ref TEXT, provider_capture_ref TEXT UNIQUE,
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0), currency TEXT NOT NULL,
 lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, grant_id TEXT,
 UNIQUE(mandate_id, period_start)
);
CREATE TABLE billing_card_charge_attempts (
 id TEXT PRIMARY KEY, charge_id TEXT NOT NULL, generation INTEGER NOT NULL, provider_order_ref TEXT,
 provider_capture_ref TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(charge_id, generation)
);
CREATE TABLE billing_commerce_orders (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, product TEXT NOT NULL, product_ref TEXT NOT NULL,
 subtotal_minor INTEGER NOT NULL, discount_minor INTEGER NOT NULL DEFAULT 0, tax_minor INTEGER NOT NULL DEFAULT 0,
 total_minor INTEGER NOT NULL, currency TEXT NOT NULL, coupon_id TEXT, tax_status TEXT NOT NULL DEFAULT 'not_collected',
 provider TEXT NOT NULL, purchase_ref TEXT NOT NULL UNIQUE, status TEXT NOT NULL, entitlement_status TEXT NOT NULL DEFAULT 'pending',
 metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK(subtotal_minor>=0 AND discount_minor>=0 AND tax_minor>=0 AND total_minor=subtotal_minor-discount_minor+tax_minor)
);
CREATE INDEX idx_commerce_orders_owner ON billing_commerce_orders(account_id, created_at);
CREATE TABLE billing_coupons (
 id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, product TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('fixed','percent')), value INTEGER NOT NULL CHECK(value>0),
 currency TEXT NOT NULL DEFAULT 'USD', starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
 max_redemptions INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE billing_coupon_uses (
 id TEXT PRIMARY KEY, coupon_id TEXT NOT NULL, order_id TEXT NOT NULL UNIQUE,
 account_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(coupon_id,account_id)
);
CREATE TABLE mojo_gift_deliveries (
 gift_id TEXT PRIMARY KEY, recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('user','email','link')),
 recipient_email_encrypted TEXT, recipient_email_hash TEXT, token_hash TEXT UNIQUE,
 redemption_expires_at INTEGER, delivery_status TEXT NOT NULL DEFAULT 'awaiting_payment',
 delivered_at INTEGER, redeemed_by TEXT, revoked_at INTEGER, revoked_by TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_gift_delivery_email ON mojo_gift_deliveries(recipient_email_hash, delivery_status);
CREATE TABLE billing_notification_jobs (
 id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, account_id TEXT, gift_id TEXT,
 kind TEXT NOT NULL, resource_id TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER, next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER,
 last_error TEXT
);
CREATE INDEX idx_billing_notifications_due ON billing_notification_jobs(status, next_attempt_at);
-- Gift time held until an independently renewing paid subscription ends. Never changes the payment method or mandate.
CREATE TABLE mojo_gift_credits (
 gift_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, user_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'waiting', next_check_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, applied_at INTEGER, grant_id TEXT
);
CREATE INDEX idx_gift_credits_owner ON mojo_gift_credits(account_id, status);
