-- 2026-10-28 (API 0.46.0): account safety and profile additions (docs/ACCOUNT_SAFETY.md). Additive only: new tables
-- and two nullable columns, so an older server image runs on this schema unchanged. No foreign keys to accounts: with
-- MONGODB_DOMAINS=accounts the account rows live in MongoDB (as account_passkeys, migration 045), so deleting an
-- account deletes these rows explicitly (accounts/deletion.ts).

-- Two-step sign-in with an authenticator app (TOTP, RFC 6238: SHA-1, 6 digits, 30 seconds). [secret] is sealed with the
-- server's PLATFORM_SECRETS_KEY (AES-256-GCM, bound to the account), never stored in the clear. [enabled_at] is NULL
-- while set-up waits for the first code. [last_step] is the last time step used, so a code works once.
CREATE TABLE account_totp (
  account_id  TEXT PRIMARY KEY,
  secret      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  enabled_at  INTEGER,
  last_step   INTEGER NOT NULL DEFAULT 0
);

-- Backup codes for when the authenticator is lost: SHA-256 of "<account id>:totp-backup:<code>", each usable once.
CREATE TABLE account_totp_backup (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  code_hash   TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_account_totp_backup_account ON account_totp_backup(account_id);

-- A change of email in progress: a code was sent to [new_email]; the change happens when it comes back. One per account.
CREATE TABLE account_email_changes (
  account_id  TEXT PRIMARY KEY,
  new_email   TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Warnings from Meldiq's staff (account standing). Active while expires_at is in the future and revoked_at is NULL;
-- the number of active warnings sets what the account may do (accounts/standing.ts).
CREATE TABLE account_warnings (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX idx_account_warnings_user ON account_warnings(user_id, expires_at);

-- Bug reports from people (Settings › My Account › Report a bug). Staff set the status; a confirmed or fixed report
-- earns its reporter the Bug Hunter badge.
CREATE TABLE bug_reports (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary     TEXT NOT NULL,
  details     TEXT NOT NULL,
  page        TEXT,
  client      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'fixed', 'not_a_bug', 'duplicate')),
  staff_note  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_bug_reports_user ON bug_reports(user_id, created_at);
CREATE INDEX idx_bug_reports_status ON bug_reports(status, created_at);

-- Profile additions: an "About me" (up to 300 characters) and up to 5 links (JSON [{label, url}], https only), shown
-- under the bio's privacy setting.
ALTER TABLE users ADD COLUMN about_me TEXT;
ALTER TABLE users ADD COLUMN profile_links TEXT;
