-- Public encryption material only. Bot private keys never enter the API or account/device tables.
ALTER TABLE bot_requested_permissions ADD COLUMN voice_public_key TEXT;
