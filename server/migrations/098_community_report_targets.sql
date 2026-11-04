-- Optional community target. org_id stays NULL for operator-only routing.
-- Like reports.org_id, this crosses independently migrated domains; the existing deleteForOrg cleanup owns it.
ALTER TABLE reports ADD COLUMN target_org_id TEXT;
CREATE INDEX reports_target_community ON reports(target_org_id);
