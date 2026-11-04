-- Optional, recipient-only note. Cleared atomically whenever a pending request becomes a connection.
ALTER TABLE connections ADD COLUMN request_note TEXT CHECK (request_note IS NULL OR length(request_note) <= 300);
CREATE TRIGGER connections_note_pending_insert AFTER INSERT ON connections WHEN NEW.state<>'pending' AND NEW.request_note IS NOT NULL
BEGIN UPDATE connections SET request_note=NULL WHERE pair=NEW.pair; END;
CREATE TRIGGER connections_note_pending_update AFTER UPDATE OF state,request_note ON connections WHEN NEW.state<>'pending' AND NEW.request_note IS NOT NULL
BEGIN UPDATE connections SET request_note=NULL WHERE pair=NEW.pair; END;
