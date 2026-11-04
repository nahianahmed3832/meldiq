-- Private community-owner application; approval is a manual review record and grants no badge or powers.
CREATE TABLE org_partner_applications (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  submitted_by TEXT NOT NULL,
  statement TEXT NOT NULL,
  checklist TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('submitted','approved','declined')),
  rev INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  review_note TEXT
);
CREATE INDEX partner_application_queue ON org_partner_applications(status,submitted_at,org_id);
