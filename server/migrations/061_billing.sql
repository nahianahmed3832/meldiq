-- 2026-10-28 (API 0.49.0): the subscription foundation (docs/BILLING.md). Additive only: new tables and two nullable
-- columns, so an older server image runs on this schema unchanged. No foreign keys to accounts (MONGODB_DOMAINS, as
-- migration 045). Nothing here charges anyone: payments happen at a billing provider, and these rows record what the
-- provider confirmed through signed webhooks.

-- Operator limits (migration 026) gain an optional end and the reason they were set. NULL expires_at: no end (rows set
-- before this migration, or a super admin's explicit choice).
ALTER TABLE org_entitlements ADD COLUMN expires_at INTEGER;
ALTER TABLE org_entitlements ADD COLUMN reason TEXT;

-- The plan catalog: one row per commercial offer. Terms live in versions; a plan's own row holds only what never
-- changes what anyone pays (names, description, visibility).
CREATE TABLE billing_plans (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,         -- internal key, e.g. "team"; never shown to customers
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  segment      TEXT NOT NULL DEFAULT '',     -- who it is for, free text for operators
  public       INTEGER NOT NULL DEFAULT 0,   -- offered to customers when published
  status       TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Plan terms, versioned. A draft (published_at NULL) may be edited; a published version never changes (the trigger
-- below), so a subscription keeps the terms it started on until it moves to another version on purpose.
CREATE TABLE billing_plan_versions (
  id                  TEXT PRIMARY KEY,
  plan_id             TEXT NOT NULL REFERENCES billing_plans(id),
  version             INTEGER NOT NULL,
  interval            TEXT NOT NULL CHECK (interval IN ('month', 'year')),
  currency            TEXT NOT NULL,          -- ISO 4217, upper case
  amount_minor        INTEGER NOT NULL CHECK (amount_minor >= 0),  -- list price per interval, in the currency's minor unit
  provider            TEXT,                   -- the billing provider this price lives at
  provider_price_ref  TEXT,                   -- that provider's price id
  trial_days          INTEGER NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  grace_days          INTEGER NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 60),
  limits              TEXT NOT NULL DEFAULT '{}',  -- JSON: entitlement key -> whole number (absent: no plan limit)
  notes               TEXT NOT NULL DEFAULT '',
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  published_at        INTEGER,
  published_by        TEXT,
  retired_at          INTEGER,                -- no longer offered to new subscribers (existing ones keep it)
  UNIQUE (plan_id, version)
);
CREATE UNIQUE INDEX idx_billing_price_ref ON billing_plan_versions(provider, provider_price_ref) WHERE provider_price_ref IS NOT NULL;
CREATE INDEX idx_billing_plan_versions_plan ON billing_plan_versions(plan_id, version);

CREATE TRIGGER billing_plan_versions_frozen BEFORE UPDATE ON billing_plan_versions
WHEN OLD.published_at IS NOT NULL AND (
  NEW.interval IS NOT OLD.interval OR NEW.currency IS NOT OLD.currency OR NEW.amount_minor IS NOT OLD.amount_minor OR
  NEW.provider IS NOT OLD.provider OR NEW.provider_price_ref IS NOT OLD.provider_price_ref OR
  NEW.trial_days IS NOT OLD.trial_days OR NEW.grace_days IS NOT OLD.grace_days OR NEW.limits IS NOT OLD.limits OR
  NEW.plan_id IS NOT OLD.plan_id OR NEW.version IS NOT OLD.version
)
BEGIN
  SELECT RAISE(ABORT, 'a published plan version is immutable');
END;

-- Checkouts started by an organization's owner. A provider's webhook links a subscription to an organization only
-- through one of these (its [id] travels as the provider's reference), never through an organization id it sends.
CREATE TABLE billing_checkouts (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  user_id             TEXT NOT NULL,          -- who started it (an owner then): becomes the subscription's billing owner
  plan_version_id     TEXT NOT NULL REFERENCES billing_plan_versions(id),
  provider            TEXT NOT NULL,
  provider_session_ref TEXT,
  status              TEXT NOT NULL CHECK (status IN ('open', 'completed', 'expired')),
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX idx_billing_checkouts_org ON billing_checkouts(org_id, created_at);

-- Subscriptions: one organization, one billing owner, one plan version, in one lifecycle state (docs/BILLING.md).
CREATE TABLE billing_subscriptions (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL,
  billing_user_id         TEXT NOT NULL,     -- the users.id who started the checkout
  plan_version_id         TEXT NOT NULL REFERENCES billing_plan_versions(id),
  status                  TEXT NOT NULL CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'incomplete_expired')),
  provider                TEXT NOT NULL,
  provider_customer_ref   TEXT,
  provider_subscription_ref TEXT NOT NULL,
  checkout_id             TEXT,
  current_period_start    INTEGER,
  current_period_end      INTEGER,
  trial_end               INTEGER,
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0,
  canceled_at             INTEGER,
  past_due_since          INTEGER,
  provider_updated_at     INTEGER NOT NULL,  -- the provider's time of the newest state applied (older events are ignored)
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE (provider, provider_subscription_ref)
);
CREATE INDEX idx_billing_subscriptions_org ON billing_subscriptions(org_id, updated_at);
CREATE INDEX idx_billing_subscriptions_status ON billing_subscriptions(status, updated_at);

-- Every lifecycle change of a subscription, oldest first. Never edited.
CREATE TABLE billing_subscription_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id  TEXT NOT NULL,
  at               INTEGER NOT NULL,
  from_status      TEXT,
  to_status        TEXT NOT NULL,
  plan_version_id  TEXT NOT NULL,
  source           TEXT NOT NULL,     -- "provider_event:<event row id>"
  detail           TEXT               -- JSON: what changed besides the status
);
CREATE INDEX idx_billing_history_subscription ON billing_subscription_history(subscription_id, id);
CREATE INDEX idx_billing_history_at ON billing_subscription_history(at);

-- Invoices as the provider reported them. Amounts in the currency's minor unit; never computed here.
CREATE TABLE billing_invoices (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  provider_invoice_ref  TEXT NOT NULL,
  subscription_id       TEXT,
  org_id                TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('open', 'paid', 'payment_failed', 'void', 'uncollectible')),
  currency              TEXT NOT NULL,
  amount_due_minor      INTEGER NOT NULL CHECK (amount_due_minor >= 0),
  amount_paid_minor     INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  amount_refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded_minor >= 0),
  tax_minor             INTEGER,       -- NULL: the provider didn't say
  period_start          INTEGER,
  period_end            INTEGER,
  issued_at             INTEGER NOT NULL,
  paid_at               INTEGER,
  provider_updated_at   INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (provider, provider_invoice_ref)
);
CREATE INDEX idx_billing_invoices_org ON billing_invoices(org_id, issued_at);
CREATE INDEX idx_billing_invoices_paid ON billing_invoices(status, paid_at);

-- Provider webhooks that passed the signature check, one row per provider event id (duplicates are acknowledged and
-- skipped). Only a minimal summary of the payload is kept, never card or bank details.
CREATE TABLE billing_provider_events (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  event_ref        TEXT NOT NULL,
  type             TEXT NOT NULL,
  provider_created_at INTEGER NOT NULL,
  received_at      INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  last_error       TEXT,
  processed_at     INTEGER,
  subscription_id  TEXT,
  summary          TEXT NOT NULL,     -- JSON: the normalized event the processor reads
  UNIQUE (provider, event_ref)
);
CREATE INDEX idx_billing_events_status ON billing_provider_events(status, next_attempt_at);
CREATE INDEX idx_billing_events_received ON billing_provider_events(received_at);

-- Webhooks refused before they were trusted (bad or missing signature, unreadable body), counted per UTC day.
CREATE TABLE billing_webhook_rejections (
  day       TEXT NOT NULL,
  provider  TEXT NOT NULL,
  reason    TEXT NOT NULL,
  count     INTEGER NOT NULL,
  PRIMARY KEY (day, provider, reason)
);
