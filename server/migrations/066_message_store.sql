-- 2026-10-29 (API 0.56.0): messages stored and served by the server (docs/SERVER_MESSAGES.md). The owner's decision:
-- Meldiq no longer encrypts messages end to end; the server keeps every message and every change to one (edits,
-- reactions, deletions, votes, pins, read markers) and serves a conversation's history to any member's device. Apps
-- keep nothing but their sign-in. Additive: older images ignore the table.
CREATE TABLE message_events (
  id                TEXT PRIMARY KEY,          -- the message or control id the app chose (idempotency)
  conversation_id   TEXT NOT NULL,
  sender_user_id    TEXT NOT NULL,
  sender_device_id  TEXT,                      -- NULL for history an app imported
  cls               TEXT NOT NULL CHECK (cls IN ('message', 'control')),
  type              TEXT NOT NULL,             -- the payload's type: text, edit, delete, reaction, pin, vote, read, ...
  target            TEXT,                      -- a control's message (payload.target)
  audience          TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'self')),
  payload           TEXT NOT NULL,             -- the payload as JSON, readable by the server
  sent_at           INTEGER NOT NULL,
  server_ts         INTEGER NOT NULL,
  mention_all       INTEGER NOT NULL DEFAULT 0,
  imported_by       TEXT                       -- who uploaded it from their device's history when the app updated (NULL: sent live)
);
CREATE INDEX idx_message_events_page ON message_events(conversation_id, cls, server_ts);
CREATE INDEX idx_message_events_target ON message_events(conversation_id, target);
CREATE INDEX idx_message_events_sender ON message_events(sender_user_id);

-- The delivery queue also carries stored messages to each member's devices ("message" items): SQLite can't widen a
-- CHECK, so the table is rebuilt with the same columns, rows, indexes and id sequence.
CREATE TABLE delivery_queue_rebuilt (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_device_id  TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('envelope','receipt','message')),
  conversation_id      TEXT NOT NULL,
  message_id           TEXT NOT NULL,
  sender_user_id       TEXT NOT NULL,
  sender_device_id     TEXT NOT NULL,
  payload              TEXT NOT NULL,         -- JSON: a stored message, an older app's envelope, or a receipt
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL
);
INSERT INTO delivery_queue_rebuilt (id, recipient_device_id, kind, conversation_id, message_id, sender_user_id, sender_device_id, payload, created_at, expires_at)
  SELECT id, recipient_device_id, kind, conversation_id, message_id, sender_user_id, sender_device_id, payload, created_at, expires_at FROM delivery_queue;
-- The id sequence carries over (ids already handed out are never reused): copied rows made the new table's entry; the
-- old table's highest id may be above them (its newest items already acknowledged).
INSERT INTO sqlite_sequence (name, seq) SELECT 'delivery_queue_rebuilt', MAX(seq) FROM sqlite_sequence WHERE name = 'delivery_queue'
  HAVING MAX(seq) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'delivery_queue_rebuilt');
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT IFNULL(MAX(seq), 0) FROM sqlite_sequence WHERE name = 'delivery_queue'))
  WHERE name = 'delivery_queue_rebuilt';
DROP TABLE delivery_queue;
ALTER TABLE delivery_queue_rebuilt RENAME TO delivery_queue;
CREATE INDEX idx_queue_recipient ON delivery_queue(recipient_device_id, id);
CREATE INDEX idx_queue_expiry ON delivery_queue(expires_at);
CREATE UNIQUE INDEX idx_queue_unique ON delivery_queue(recipient_device_id, kind, message_id, sender_device_id);
