-- Bounded metadata-only execution history for community bot administrators.
CREATE TABLE bot_runtime_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  bot_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok','failed')),
  at INTEGER NOT NULL
);
CREATE INDEX idx_bot_runtime_events_scope ON bot_runtime_events(org_id,bot_key,at DESC,id DESC);
