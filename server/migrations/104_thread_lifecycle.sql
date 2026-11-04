CREATE TABLE message_threads (
  root_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  root_ts INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),
  locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)),
  delete_requested INTEGER NOT NULL DEFAULT 0 CHECK(delete_requested IN (0,1)),
  delete_parent INTEGER NOT NULL DEFAULT 0 CHECK(delete_parent IN (0,1)),
  deleted_at INTEGER,
  deletion_actor TEXT,
  deletion_device TEXT,
  deletion_error TEXT,
  delete_cursor_ts INTEGER, delete_cursor_id TEXT,
  pending_target TEXT,
  deleted_replies INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX thread_delete_pending ON message_threads(delete_requested,deleted_at,deletion_error);
CREATE TABLE thread_preferences (
  root_id TEXT NOT NULL REFERENCES message_threads(root_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  following INTEGER NOT NULL CHECK(following IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(root_id,user_id)
);
CREATE INDEX thread_preferences_account ON thread_preferences(user_id);
