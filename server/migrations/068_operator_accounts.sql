-- 2026-10-29 (API 0.62.0): accounts created from the Platform Admin Console (docs/ADMIN_ACCOUNTS.md). Additive: older
-- images ignore the table. A new table (a new MongoDB collection when the platform domain lives there), so production's
-- readWrite-only user never needs collMod.
--
-- operator_accounts: one row per account an operator made, with how it proves its email. verification: verified (no
-- code), static_code (a fixed code the operator set, stored like an emailed code: a hash bound to the account), or
-- email (the normal emailed code). The account itself lives in the accounts domain; nothing here refers to it by key.

CREATE TABLE operator_accounts (
  account_id       TEXT PRIMARY KEY,
  verification     TEXT NOT NULL CHECK (verification IN ('verified', 'static_code', 'email')),
  code_hash        TEXT,
  code_expires_at  INTEGER,
  tester           INTEGER NOT NULL DEFAULT 0 CHECK (tester IN (0, 1)),
  note             TEXT,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_by       TEXT NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((verification = 'static_code') = (code_hash IS NOT NULL))
);
CREATE INDEX operator_accounts_created ON operator_accounts (created_at DESC, account_id DESC);
