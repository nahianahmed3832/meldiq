-- 2026-10-28 (API 0.55.0): Google Play purchases for Meldiq Mojo on Android (docs/MOJO_ANDROID.md). Additive: 0.54.0
-- ignores the table.
--
-- One row per Google Play purchase token the server has verified. [token_hash] is unique, so one Google purchase can
-- belong to one Meldiq account only. [purchase_token] is kept to ask Google again (renewals, refunds, reconciliation);
-- it is never logged, returned to a client or used as a reference anywhere else (subscriptions and events use the hash).
CREATE TABLE billing_play_purchases (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL UNIQUE,
  purchase_token  TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('plan', 'spark', 'gift')),
  account_id      TEXT NOT NULL,
  -- Our checkout (billing_checkouts.id) or gift (mojo_gifts.id) the purchase was started with.
  reference       TEXT,
  -- Google's state as last read, and whether the server has acknowledged (subscriptions) or consumed (gifts) it.
  state           TEXT NOT NULL,
  acknowledged    INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
  consumed        INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- When Google was last asked (reconciliation reads the oldest first).
  checked_at      INTEGER NOT NULL
);
CREATE INDEX idx_play_purchases_account ON billing_play_purchases(account_id);
CREATE INDEX idx_play_purchases_checked ON billing_play_purchases(checked_at);
