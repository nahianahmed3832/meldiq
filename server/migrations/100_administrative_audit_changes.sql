-- Optional redacted administrative changes. Message/report contents and credentials never belong here.
ALTER TABLE audit_log ADD COLUMN changes_json TEXT CHECK(changes_json IS NULL OR json_valid(changes_json));
