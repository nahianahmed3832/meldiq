-- Additive: existing agreements, transactions and grants are never rewritten.
CREATE TABLE billing_promotion_settings (
 id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, settings TEXT NOT NULL,
 updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE billing_promotion_state (
 account_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 opt_out INTEGER NOT NULL DEFAULT 0, sessions TEXT NOT NULL DEFAULT '[]', history TEXT NOT NULL DEFAULT '[]',
 snoozed_until INTEGER NOT NULL DEFAULT 0, dismissed_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE billing_promotion_events (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, impression_id TEXT,
 session_id TEXT NOT NULL, type TEXT NOT NULL, presentation TEXT NOT NULL, at INTEGER NOT NULL,
 variant TEXT NOT NULL DEFAULT 'control'
);
CREATE INDEX idx_promotion_events_at ON billing_promotion_events(at);
CREATE INDEX idx_promotion_events_account ON billing_promotion_events(account_id, at);
