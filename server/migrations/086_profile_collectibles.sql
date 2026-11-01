-- Additive only: existing users.profile_style remains the canonical equipped profile.
CREATE TABLE profile_collectible_catalog (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE profile_collectible_inventory (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 decoration_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, acquisition_source TEXT NOT NULL,
 is_favorite INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, decoration_id)
);
CREATE INDEX idx_collectible_inventory_recent ON profile_collectible_inventory(user_id, acquired_at);
CREATE TABLE profile_collectible_transactions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 decoration_id TEXT NOT NULL, transaction_type TEXT NOT NULL, price INTEGER NOT NULL,
 currency TEXT NOT NULL, payment_reference TEXT, created_at INTEGER NOT NULL,
 UNIQUE(user_id, decoration_id)
);
CREATE INDEX idx_collectible_transactions_user ON profile_collectible_transactions(user_id, created_at);
CREATE TABLE profile_collectible_assets (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE profile_collectible_uploads (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX idx_collectible_upload_expiry ON profile_collectible_uploads(expires_at);
