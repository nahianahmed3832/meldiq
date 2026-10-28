-- 2026-10-28 (API 0.54.0): Meldiq Mojo's perks, Meldiq Spark and gifts (docs/MOJO.md). Additive for older images:
-- 0.53.0 ignores the new tables and columns, and the rebuilt billing_grants keeps every column and value it had.

-- How many of the plan a subscription is for: always 1 for Mojo Go and Plus, the number of Sparks for the Spark add-on.
ALTER TABLE billing_subscriptions ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0);
ALTER TABLE billing_checkouts ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1);

-- Free periods may now also come from a gift a friend paid for (reference = the gift's id).
CREATE TABLE billing_grants_rebuilt (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  user_id     TEXT,
  plan_key    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('signup_trial', 'referral_invitee', 'referral_inviter', 'gift')),
  reference   TEXT,
  once_key    TEXT UNIQUE,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL CHECK (ends_at > starts_at),
  created_at  INTEGER NOT NULL
);
INSERT INTO billing_grants_rebuilt (id, account_id, user_id, plan_key, source, reference, once_key, starts_at, ends_at, created_at)
  SELECT id, account_id, user_id, plan_key, source, reference, once_key, starts_at, ends_at, created_at FROM billing_grants;
DROP TABLE billing_grants;
ALTER TABLE billing_grants_rebuilt RENAME TO billing_grants;
CREATE UNIQUE INDEX idx_billing_grants_reference ON billing_grants(account_id, reference) WHERE reference IS NOT NULL;
CREATE INDEX idx_billing_grants_account ON billing_grants(account_id, ends_at);
CREATE INDEX idx_billing_grants_user ON billing_grants(user_id) WHERE user_id IS NOT NULL;

-- A Spark a person gives to a server. A person's Sparks are their plan's included ones plus the add-on's quantity; their
-- assignments count oldest first up to that many (the rest are paused, never deleted, and count again when there is
-- room). Removing or moving one ends its row; the rows are the history.
CREATE TABLE spark_assignments (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  assigned_at     INTEGER NOT NULL,
  removed_at      INTEGER,
  removed_reason  TEXT CHECK (removed_reason IN ('removed', 'moved', 'left', 'org_deleted', 'account_deleted'))
);
CREATE INDEX idx_spark_assignments_user ON spark_assignments(user_id, assigned_at) WHERE removed_at IS NULL;
CREATE INDEX idx_spark_assignments_org ON spark_assignments(org_id) WHERE removed_at IS NULL;

-- A gift of Mojo Go or Plus for a friend: paid once (never renews), then waiting for the friend to start it.
CREATE TABLE mojo_gifts (
  id                    TEXT PRIMARY KEY,
  buyer_account_id      TEXT NOT NULL,
  buyer_user_id         TEXT,
  recipient_user_id     TEXT NOT NULL,
  plan_key              TEXT NOT NULL CHECK (plan_key IN ('go', 'plus')),
  months                INTEGER NOT NULL CHECK (months IN (1, 3, 12)),
  currency              TEXT NOT NULL,
  amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
  note                  TEXT,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'redeemed', 'refunded', 'expired', 'failed')),
  provider              TEXT NOT NULL,
  provider_session_ref  TEXT UNIQUE,
  provider_payment_ref  TEXT,
  grant_id              TEXT,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  paid_at               INTEGER,
  redeemed_at           INTEGER,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_mojo_gifts_recipient ON mojo_gifts(recipient_user_id, status);
CREATE INDEX idx_mojo_gifts_buyer ON mojo_gifts(buyer_account_id, created_at);
CREATE INDEX idx_mojo_gifts_payment ON mojo_gifts(provider, provider_payment_ref) WHERE provider_payment_ref IS NOT NULL;

-- Whether a person shows their Mojo badge (hiding it changes only what others see, never what the plan gives).
CREATE TABLE mojo_profile (
  user_id       TEXT PRIMARY KEY,
  badge_hidden  INTEGER NOT NULL DEFAULT 0 CHECK (badge_hidden IN (0, 1)),
  updated_at    INTEGER NOT NULL
);
