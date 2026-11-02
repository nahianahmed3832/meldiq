-- Additive operational controls, using the existing platform and billing authorities.
CREATE TABLE platform_notices (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
 target_user_id TEXT, status TEXT NOT NULL DEFAULT 'draft', starts_at INTEGER NOT NULL,
 ends_at INTEGER, version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_platform_notices_live ON platform_notices(status, starts_at, id);
CREATE INDEX idx_platform_notices_target ON platform_notices(target_user_id, created_at, id);
CREATE TABLE platform_notice_receipts (
 notice_id TEXT NOT NULL, user_id TEXT NOT NULL, read_at INTEGER NOT NULL,
 PRIMARY KEY(notice_id, user_id)
);
CREATE TABLE platform_appeals (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, notice_id TEXT, subject TEXT NOT NULL,
 body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', decision TEXT,
 assigned_to TEXT, notified_version INTEGER NOT NULL DEFAULT 0, notification_error TEXT, delivery_pending INTEGER NOT NULL DEFAULT 0, next_delivery_at INTEGER NOT NULL DEFAULT 0, sync_status TEXT NOT NULL DEFAULT 'complete', version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_platform_appeals_status ON platform_appeals(status, created_at, id);
CREATE INDEX idx_platform_appeals_user ON platform_appeals(user_id, created_at, id);
CREATE TABLE platform_ownership_requests (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, target_user_id TEXT NOT NULL,
 requested_by TEXT NOT NULL, approved_name TEXT, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE INDEX idx_platform_ownership_requests_org ON platform_ownership_requests(org_id, status);
CREATE TABLE billing_promotions (
 code TEXT PRIMARY KEY, title TEXT NOT NULL, product TEXT NOT NULL DEFAULT 'plus_time', discount_percent INTEGER NOT NULL DEFAULT 0, months INTEGER NOT NULL, max_redemptions INTEGER NOT NULL,
 redeemed INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
 starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE billing_promotion_redemptions (
 code TEXT NOT NULL, account_id TEXT NOT NULL, user_id TEXT NOT NULL, grant_id TEXT NOT NULL,
 redeemed_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'redeemed', PRIMARY KEY(code, account_id)
);
CREATE TABLE collectible_orders (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, user_id TEXT NOT NULL, item_id TEXT NOT NULL,
 item_version INTEGER NOT NULL, amount_minor INTEGER NOT NULL, original_amount_minor INTEGER NOT NULL, promotion_code TEXT, currency TEXT NOT NULL,
 provider TEXT NOT NULL, session_ref TEXT, checkout_url TEXT, payment_ref TEXT,
 status TEXT NOT NULL DEFAULT 'pending', sync_status TEXT NOT NULL DEFAULT 'pending',
 request_key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(account_id, request_key)
);
CREATE INDEX idx_collectible_orders_sync ON collectible_orders(sync_status, updated_at);
CREATE INDEX idx_collectible_orders_history ON collectible_orders(created_at, id);
CREATE UNIQUE INDEX idx_collectible_orders_payment ON collectible_orders(provider, payment_ref) WHERE payment_ref IS NOT NULL;

CREATE TABLE platform_appeal_challenges (
 id TEXT PRIMARY KEY, account_id TEXT, user_id TEXT, code_hash TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX idx_platform_appeal_challenges_expiry ON platform_appeal_challenges(expires_at);

CREATE INDEX idx_platform_appeals_delivery ON platform_appeals(delivery_pending, next_delivery_at, updated_at);
