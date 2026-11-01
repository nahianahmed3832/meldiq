-- Central administration: explicit grant restrictions, moderator, report workflow and community suspension.
-- No identity, subscription, message or report rows are removed. Existing grants keep their default permissions.
CREATE TABLE platform_admins_next (
 account_id TEXT PRIMARY KEY,
 role TEXT NOT NULL CHECK(role IN ('super_admin','operations_admin','platform_moderator','support_admin','billing_admin','auditor')),
 granted_by TEXT, granted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 revoked_at INTEGER, revoked_by TEXT, note TEXT, permissions TEXT
);
INSERT INTO platform_admins_next(account_id,role,granted_by,granted_at,updated_at,revoked_at,revoked_by,note)
 SELECT account_id,role,granted_by,granted_at,updated_at,revoked_at,revoked_by,note FROM platform_admins;
DROP TABLE platform_admins;
ALTER TABLE platform_admins_next RENAME TO platform_admins;
CREATE INDEX idx_platform_admins_role ON platform_admins(role);
ALTER TABLE orgs ADD COLUMN platform_suspended_at INTEGER;
ALTER TABLE orgs ADD COLUMN platform_suspended_until INTEGER;
CREATE INDEX idx_orgs_platform_suspension ON orgs(platform_suspended_at,platform_suspended_until);
CREATE TABLE platform_report_cases (
 report_id TEXT PRIMARY KEY,
 assignee_account_id TEXT,
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 appeal_status TEXT NOT NULL DEFAULT 'none' CHECK(appeal_status IN ('none','open','upheld','overturned')),
 sync_status TEXT NOT NULL DEFAULT 'synced',
 intended_status TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL
);
CREATE INDEX idx_platform_report_assignee ON platform_report_cases(assignee_account_id,priority);
CREATE TABLE platform_report_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 report_id TEXT NOT NULL,
 actor_account_id TEXT NOT NULL,
 at INTEGER NOT NULL,
 kind TEXT NOT NULL,
 body TEXT NOT NULL
);
CREATE INDEX idx_platform_report_events ON platform_report_events(report_id,id);

CREATE INDEX idx_reports_admin ON reports(status,created_at DESC,id DESC);
