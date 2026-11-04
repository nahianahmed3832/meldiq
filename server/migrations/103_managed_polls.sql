-- Managed polls keep answer keys and identified ballots out of message payloads and relay queues.
CREATE TABLE managed_polls (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  definition TEXT NOT NULL CHECK(json_valid(definition)),
  answer_key TEXT CHECK(answer_key IS NULL OR json_valid(answer_key)),
  fingerprint TEXT NOT NULL,
  closed_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE managed_poll_votes (
  message_id TEXT NOT NULL REFERENCES managed_polls(message_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  choices TEXT NOT NULL CHECK(json_valid(choices)),
  anonymous INTEGER NOT NULL CHECK(anonymous IN (0,1)),
  PRIMARY KEY(message_id,user_id)
);
CREATE INDEX managed_poll_conversation ON managed_polls(conversation_id);
