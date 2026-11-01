-- Match the full history order for both pagination directions, including equal timestamps.
CREATE INDEX IF NOT EXISTS message_events_history_cursor ON message_events(conversation_id, cls, server_ts, id);
