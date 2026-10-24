-- 2026-10-25: Full System Check reports (docs/implementation/PROGRESS.md phase 2). Additive only.
-- One row per run: a community's check (org_id set, run by someone with "Manage AI agents") or the platform's (org_id
-- NULL, run by a console operator or on schedule). The report holds statuses, counts and ids only, never message or
-- file content. The newest 50 per scope are kept.
CREATE TABLE ai_system_checks (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('community', 'platform')),
  org_id        TEXT,
  requested_by  TEXT NOT NULL,                     -- a user id, a console account id, or 'schedule'
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER NOT NULL,
  worst         TEXT NOT NULL,                     -- the worst status in the report (healthy … failed)
  summary       TEXT NOT NULL,                     -- JSON: count per status
  report        TEXT NOT NULL                      -- JSON: the items
);
CREATE INDEX idx_ai_system_checks_scope ON ai_system_checks(scope, org_id, started_at);
