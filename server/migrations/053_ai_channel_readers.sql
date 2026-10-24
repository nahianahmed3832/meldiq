-- 2026-10-25: AI agents reading channels, opt-in per channel (docs/AI_WORKFORCE_2_PLAN.md phase 5,
-- docs/AI_AGENT_CHANNEL_READ_PROPOSAL.md). Additive only. Nothing reads a channel until the platform setting
-- ai.workforce.channel_reading is on and a channel's manager switches a reader on.

-- An installed agent's bot identity: a users row of kind 'agent' (no account: it can't sign in, be searched, be DMed by
-- others or join anything). Its identity seed is sealed (see ai_channel_readers.reader_key).
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'agent'));
CREATE TABLE ai_agent_identities (
  install_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL UNIQUE,
  identity_seed  TEXT NOT NULL,                    -- sealed under the identity key derived from PLATFORM_SECRETS_KEY
  created_at     INTEGER NOT NULL
);

-- A reader: one agent's device in one conversation, from switch-on until switch-off. Its device keys are sealed under a
-- random per-reader key, itself wrapped by the platform key; switching off deletes that key (the rest can't be opened).
CREATE TABLE ai_channel_readers (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  install_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  device_id        TEXT NOT NULL UNIQUE,
  reader_key       TEXT,                           -- wrapped per-reader key; NULL once switched off (crypto-shredded)
  device_keys      TEXT,                           -- sealed device signing and encryption keys
  state            TEXT NOT NULL CHECK (state IN ('on', 'off')),
  mode             TEXT NOT NULL DEFAULT 'channel' CHECK (mode IN ('channel', 'direct')),
  turned_on_by     TEXT NOT NULL,
  reason           TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  turned_off_at    INTEGER,
  turned_off_by    TEXT,
  off_reason       TEXT
);
-- At most one reader per agent and conversation while on: enforced by ChannelReaders.create (synchronous, checks first).
CREATE INDEX idx_ai_readers_conv ON ai_channel_readers(conversation_id, state);
CREATE INDEX idx_ai_readers_install ON ai_channel_readers(install_id, state);

-- Each member's choice for a reader, so their devices agree: share their messages with it, or keep them out.
CREATE TABLE ai_reader_choices (
  reader_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  choice     TEXT NOT NULL CHECK (choice IN ('share', 'keep')),
  at         INTEGER NOT NULL,
  PRIMARY KEY (reader_id, user_id)
);

-- What a reader kept: decrypted text, sealed under its per-reader key; at most 30 days / 2,000 messages.
CREATE TABLE ai_channel_context (
  reader_id       TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  sender_user_id  TEXT NOT NULL,
  sent_at         INTEGER NOT NULL,
  thread_root     TEXT,
  body            TEXT NOT NULL,                   -- sealed JSON {text}
  edited_at       INTEGER,
  received_at     INTEGER NOT NULL,
  PRIMARY KEY (reader_id, message_id)
);
CREATE INDEX idx_ai_context_time ON ai_channel_context(reader_id, sent_at);

-- What each message led to, once per reader: the dedupe record (outcome: ignored, job, cooldown, refused, …).
CREATE TABLE ai_reader_events (
  reader_id   TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  job_id      TEXT,
  at          INTEGER NOT NULL,
  PRIMARY KEY (reader_id, message_id)
);
CREATE INDEX idx_ai_reader_events_time ON ai_reader_events(reader_id, at);
