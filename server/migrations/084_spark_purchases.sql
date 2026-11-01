CREATE TABLE spark_purchases (
  id TEXT PRIMARY KEY,
  buyer_account_id TEXT,
  buyer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0 AND quantity <= 20),
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','paid','refunded','expired','failed')),
  provider TEXT NOT NULL,
  provider_session_ref TEXT,
  provider_payment_ref TEXT,
  request_key TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_spark_purchase_request ON spark_purchases(provider, buyer_account_id, request_key) WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX idx_spark_purchase_payment ON spark_purchases(provider, provider_payment_ref) WHERE provider_payment_ref IS NOT NULL;
CREATE INDEX idx_spark_purchase_slots ON spark_purchases(buyer_user_id, status);
