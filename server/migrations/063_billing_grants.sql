-- 2026-10-28 (API 0.53.0): free Meldiq Mojo periods that no payment provider is involved in (docs/BILLING.md › Trials
-- and invite links). Additive only: older images ignore these tables.
--
-- A grant gives an account a plan (by plan key) from starts_at to ends_at:
--   signup_trial      the trial every account gets once (14 days from sign-up, or from the day trials started);
--   referral_invitee  an account that signed up through someone's invite link (30 days from sign-up, once);
--   referral_inviter  the person whose link it was (30 days each time, up to a yearly cap; reference = the referral).

CREATE TABLE billing_grants (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  user_id     TEXT,                -- the account's encryption identity once known (quota plans)
  plan_key    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('signup_trial', 'referral_invitee', 'referral_inviter')),
  reference   TEXT,
  once_key    TEXT UNIQUE,         -- "<account>:<source>" for the grants an account gets once (trial, invitee); else NULL
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL CHECK (ends_at > starts_at),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_billing_grants_reference ON billing_grants(account_id, reference) WHERE reference IS NOT NULL;
CREATE INDEX idx_billing_grants_account ON billing_grants(account_id, ends_at);
CREATE INDEX idx_billing_grants_user ON billing_grants(user_id) WHERE user_id IS NOT NULL;

-- Each account's personal invite code (made the first time it's asked for).
CREATE TABLE billing_referral_codes (
  account_id  TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- Who signed up through whose link: an account is referred at most once.
CREATE TABLE billing_referrals (
  id                  TEXT PRIMARY KEY,
  inviter_account_id  TEXT NOT NULL,
  invitee_account_id  TEXT NOT NULL UNIQUE,
  code                TEXT NOT NULL,
  inviter_days        INTEGER NOT NULL CHECK (inviter_days >= 0),  -- 0 once the inviter's yearly cap was reached
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_billing_referrals_inviter ON billing_referrals(inviter_account_id, created_at);
