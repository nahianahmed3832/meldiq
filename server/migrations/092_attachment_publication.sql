-- New server-message uploads remain temporary until a message publishes them.
-- NULL on every existing row preserves all previous retention decisions.
ALTER TABLE attachments ADD COLUMN pending_message_until INTEGER;
ALTER TABLE attachments ADD COLUMN message_id TEXT;
ALTER TABLE attachments ADD COLUMN sha256 TEXT;
CREATE INDEX idx_attachments_pending_message ON attachments(pending_message_until) WHERE pending_message_until IS NOT NULL;
CREATE INDEX idx_attachments_message ON attachments(conversation_id, message_id) WHERE message_id IS NOT NULL;
