-- 2026-10-28 (API 0.52.0): billing owned by a person's account or by an organization, one provider customer per owner,
-- Stripe's "unpaid" state, and plans that say who they are for (docs/BILLING.md). Additive for older images: every
-- column they write keeps its name and meaning, new columns have defaults, and org_id is only nullable now (rows an
-- older image writes are organization rows, which is what owner_kind's default says).
--
-- owner_kind = 'org':     the organization org_id owns it (unchanged).
-- owner_kind = 'account': the account account_id (accounts.id, the permanent sign-in identity) owns it. account_id is
--                         used, not users.id, because an account may buy on the website before it has an encryption
--                         identity; owner_user_id records that identity once known (for per-person quota plans).

-- Who a plan is for. Existing plans were all for communities.
ALTER TABLE billing_plans ADD COLUMN audience TEXT NOT NULL DEFAULT 'organization' CHECK (audience IN ('personal', 'organization'));

-- A plan version may name the quota plan (modules/quotas, quota_plans.id) its subscribers are on while it grants.
ALTER TABLE billing_plan_versions ADD COLUMN quota_plan_id TEXT;

DROP TRIGGER billing_plan_versions_frozen;
CREATE TRIGGER billing_plan_versions_frozen BEFORE UPDATE ON billing_plan_versions
WHEN OLD.published_at IS NOT NULL AND (
  NEW.interval IS NOT OLD.interval OR NEW.currency IS NOT OLD.currency OR NEW.amount_minor IS NOT OLD.amount_minor OR
  NEW.provider IS NOT OLD.provider OR NEW.provider_price_ref IS NOT OLD.provider_price_ref OR
  NEW.trial_days IS NOT OLD.trial_days OR NEW.grace_days IS NOT OLD.grace_days OR NEW.limits IS NOT OLD.limits OR
  NEW.plan_id IS NOT OLD.plan_id OR NEW.version IS NOT OLD.version OR NEW.quota_plan_id IS NOT OLD.quota_plan_id
)
BEGIN
  SELECT RAISE(ABORT, 'a published plan version is immutable');
END;

-- One customer at a provider per owner: created before the first checkout, reused for every later checkout and the
-- customer portal, so an owner never ends up with two customers. Only references are kept, never payment details.
CREATE TABLE billing_customers (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  owner_kind            TEXT NOT NULL CHECK (owner_kind IN ('org', 'account')),
  owner_id              TEXT NOT NULL,
  provider_customer_ref TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  UNIQUE (provider, owner_kind, owner_id),
  UNIQUE (provider, provider_customer_ref)
);

-- Checkouts: an organization's (started by its owner) or an account's own. user_id (users.id of whoever started it)
-- becomes nullable: an account may have no encryption identity yet. 'superseded': a newer checkout by the same owner
-- replaced it before it finished (the provider's session is expired).
CREATE TABLE billing_checkouts_rebuilt (
  id                   TEXT PRIMARY KEY,
  owner_kind           TEXT NOT NULL DEFAULT 'org' CHECK (owner_kind IN ('org', 'account')),
  org_id               TEXT,
  account_id           TEXT,
  user_id              TEXT,
  started_by_account_id TEXT,
  plan_version_id      TEXT NOT NULL REFERENCES billing_plan_versions(id),
  provider             TEXT NOT NULL,
  provider_session_ref TEXT,
  provider_subscription_ref TEXT,            -- the subscription the provider says the finished checkout created
  status               TEXT NOT NULL CHECK (status IN ('open', 'completed', 'expired', 'superseded')),
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  CHECK ((owner_kind = 'org' AND org_id IS NOT NULL) OR (owner_kind = 'account' AND account_id IS NOT NULL))
);
INSERT INTO billing_checkouts_rebuilt (id, owner_kind, org_id, user_id, plan_version_id, provider, provider_session_ref, status, created_at, expires_at, completed_at)
  SELECT id, 'org', org_id, user_id, plan_version_id, provider, provider_session_ref, status, created_at, expires_at, completed_at FROM billing_checkouts;
DROP TABLE billing_checkouts;
ALTER TABLE billing_checkouts_rebuilt RENAME TO billing_checkouts;
CREATE INDEX idx_billing_checkouts_org ON billing_checkouts(org_id, created_at);
CREATE INDEX idx_billing_checkouts_account ON billing_checkouts(account_id, created_at);
CREATE INDEX idx_billing_checkouts_open ON billing_checkouts(status, expires_at);

-- Subscriptions gain the owner columns and the 'unpaid' state (a provider's retries are exhausted: no plan).
CREATE TABLE billing_subscriptions_rebuilt (
  id                        TEXT PRIMARY KEY,
  owner_kind                TEXT NOT NULL DEFAULT 'org' CHECK (owner_kind IN ('org', 'account')),
  org_id                    TEXT,
  account_id                TEXT,
  owner_user_id             TEXT,              -- users.id of the owning account, once it has one (account owners only)
  billing_user_id           TEXT,              -- users.id of whoever started the checkout, when known
  billing_account_id        TEXT,              -- accounts.id of whoever started the checkout, when known
  plan_version_id           TEXT NOT NULL REFERENCES billing_plan_versions(id),
  status                    TEXT NOT NULL CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete_expired')),
  provider                  TEXT NOT NULL,
  provider_customer_ref     TEXT,
  provider_subscription_ref TEXT NOT NULL,
  checkout_id               TEXT,
  current_period_start      INTEGER,
  current_period_end        INTEGER,
  trial_end                 INTEGER,
  cancel_at_period_end      INTEGER NOT NULL DEFAULT 0,
  canceled_at               INTEGER,
  past_due_since            INTEGER,
  provider_updated_at       INTEGER NOT NULL,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  UNIQUE (provider, provider_subscription_ref),
  CHECK ((owner_kind = 'org' AND org_id IS NOT NULL) OR (owner_kind = 'account' AND account_id IS NOT NULL))
);
INSERT INTO billing_subscriptions_rebuilt (id, owner_kind, org_id, billing_user_id, plan_version_id, status, provider, provider_customer_ref, provider_subscription_ref, checkout_id,
    current_period_start, current_period_end, trial_end, cancel_at_period_end, canceled_at, past_due_since, provider_updated_at, created_at, updated_at)
  SELECT id, 'org', org_id, billing_user_id, plan_version_id, status, provider, provider_customer_ref, provider_subscription_ref, checkout_id,
    current_period_start, current_period_end, trial_end, cancel_at_period_end, canceled_at, past_due_since, provider_updated_at, created_at, updated_at
  FROM billing_subscriptions;
DROP TABLE billing_subscriptions;
ALTER TABLE billing_subscriptions_rebuilt RENAME TO billing_subscriptions;
CREATE INDEX idx_billing_subscriptions_org ON billing_subscriptions(org_id, updated_at);
CREATE INDEX idx_billing_subscriptions_account ON billing_subscriptions(account_id, updated_at);
CREATE INDEX idx_billing_subscriptions_owner_user ON billing_subscriptions(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_billing_subscriptions_status ON billing_subscriptions(status, updated_at);
-- At most one checkout per subscription (a provider resending its creation can't attach a second one).
CREATE UNIQUE INDEX idx_billing_subscriptions_checkout ON billing_subscriptions(checkout_id) WHERE checkout_id IS NOT NULL;

-- Invoices: the owner of their subscription.
CREATE TABLE billing_invoices_rebuilt (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  provider_invoice_ref  TEXT NOT NULL,
  subscription_id       TEXT,
  owner_kind            TEXT NOT NULL DEFAULT 'org' CHECK (owner_kind IN ('org', 'account')),
  org_id                TEXT,
  account_id            TEXT,
  status                TEXT NOT NULL CHECK (status IN ('open', 'paid', 'payment_failed', 'void', 'uncollectible')),
  currency              TEXT NOT NULL,
  amount_due_minor      INTEGER NOT NULL CHECK (amount_due_minor >= 0),
  amount_paid_minor     INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  amount_refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded_minor >= 0),
  tax_minor             INTEGER,
  period_start          INTEGER,
  period_end            INTEGER,
  issued_at             INTEGER NOT NULL,
  paid_at               INTEGER,
  provider_updated_at   INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (provider, provider_invoice_ref),
  CHECK ((owner_kind = 'org' AND org_id IS NOT NULL) OR (owner_kind = 'account' AND account_id IS NOT NULL))
);
INSERT INTO billing_invoices_rebuilt (id, provider, provider_invoice_ref, subscription_id, owner_kind, org_id, status, currency, amount_due_minor, amount_paid_minor, amount_refunded_minor,
    tax_minor, period_start, period_end, issued_at, paid_at, provider_updated_at, updated_at)
  SELECT id, provider, provider_invoice_ref, subscription_id, 'org', org_id, status, currency, amount_due_minor, amount_paid_minor, amount_refunded_minor,
    tax_minor, period_start, period_end, issued_at, paid_at, provider_updated_at, updated_at
  FROM billing_invoices;
DROP TABLE billing_invoices;
ALTER TABLE billing_invoices_rebuilt RENAME TO billing_invoices;
CREATE INDEX idx_billing_invoices_org ON billing_invoices(org_id, issued_at);
CREATE INDEX idx_billing_invoices_account ON billing_invoices(account_id, issued_at);
CREATE INDEX idx_billing_invoices_paid ON billing_invoices(status, paid_at);
