-- 2026-10-29 (API 0.58.0): Meldiq Mojo run from the Platform Admin Console (docs/MOJO.md › Running Mojo from the
-- console, docs/BILLING.md › Running trials from the console). Additive for older images: 0.57.1 ignores the new tables
-- and columns, and the rebuilt billing_grants keeps every column and value it had.
--
-- billing_program: the trial and invite program once an operator saves it (until then BILLING_TRIAL_* decides).
-- mojo_controls:   whether plan limits are enforced (overriding MOJO_ENFORCE) and operators' changes to the plan limits
--                  and Spark levels in docs/MOJO.md (JSON; keys not set keep the built-in values).
-- billing_grants:  may now come from an operator (source 'operator'). Its columns are unchanged, so its MongoDB
--                  validator is too (production's readWrite-only user can't run collMod): only SQLite's source check is
--                  widened, by rebuilding the table.
-- billing_grant_notes: who gave an operator grant and why, and grants an operator ended early. Ending one shortens
--                  the grant's dates to now (or to an instant already past, if it hadn't started); the original dates are
--                  kept here.

CREATE TABLE billing_program (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  enabled             INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  starts_at           INTEGER,
  plan_key            TEXT NOT NULL,
  days                INTEGER NOT NULL CHECK (days BETWEEN 0 AND 365),
  referral_days       INTEGER NOT NULL CHECK (referral_days BETWEEN 0 AND 365),
  referral_cap_days   INTEGER NOT NULL CHECK (referral_cap_days BETWEEN 0 AND 3650),
  claim_window_days   INTEGER NOT NULL CHECK (claim_window_days BETWEEN 0 AND 90),
  updated_by          TEXT NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (enabled = 0 OR starts_at IS NOT NULL)
);

CREATE TABLE mojo_controls (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enforce     TEXT CHECK (enforce IN ('on', 'off', 'auto')),   -- NULL: MOJO_ENFORCE decides
  plans       TEXT NOT NULL DEFAULT '{}',                       -- {"go": {"messageChars": 2500}, …}
  levels      TEXT NOT NULL DEFAULT '{}',                       -- {"1": {"sparks": 3}, …}
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE billing_grants_rebuilt (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  user_id     TEXT,
  plan_key    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('signup_trial', 'referral_invitee', 'referral_inviter', 'gift', 'operator')),
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

CREATE TABLE billing_grant_notes (
  grant_id            TEXT PRIMARY KEY,
  granted_by          TEXT,             -- the console admin's account (operator grants)
  note                TEXT,             -- why, as the operator wrote it
  ended_at            INTEGER,          -- ended early by an operator
  ended_by            TEXT,
  original_starts_at  INTEGER,          -- the grant's dates before it was ended
  original_ends_at    INTEGER
);
