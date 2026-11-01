-- Idempotency for the existing checkout and gift systems, shared by SQLite and MongoDB.
ALTER TABLE billing_checkouts ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX idx_billing_checkout_request ON billing_checkouts(provider, account_id, request_key) WHERE request_key IS NOT NULL;
ALTER TABLE mojo_gifts ADD COLUMN request_key TEXT;
ALTER TABLE mojo_gifts ADD COLUMN refund_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE mojo_gifts ADD COLUMN dispute_status TEXT;
CREATE UNIQUE INDEX idx_mojo_gift_request ON mojo_gifts(provider, buyer_account_id, request_key) WHERE request_key IS NOT NULL;
-- Durable refund intent: one full refund per captured gift. Financial records remain in mojo_gifts/invoices.
CREATE TABLE billing_payment_actions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
  payment_ref TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, purchase_id)
);
CREATE INDEX idx_billing_actions_status ON billing_payment_actions(status, updated_at);
