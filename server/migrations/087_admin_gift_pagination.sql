-- Bounded platform gift history, including deterministic cursors when timestamps tie.
-- Existing gifts, ownership and provider state are unchanged.
CREATE INDEX idx_mojo_gifts_admin_time ON mojo_gifts(created_at DESC, id DESC);
CREATE INDEX idx_mojo_gifts_admin_status_time ON mojo_gifts(status, created_at DESC, id DESC);
