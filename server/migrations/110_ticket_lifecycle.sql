-- Additive: existing tickets keep their state and start unassigned at revision zero.
ALTER TABLE tickets ADD COLUMN claimed_by TEXT;
ALTER TABLE tickets ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
