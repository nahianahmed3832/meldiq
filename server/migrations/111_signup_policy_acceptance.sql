-- Exact signup revision and age declaration only. No birth date or device/network fingerprint.
ALTER TABLE accounts ADD COLUMN signup_policy_acceptance TEXT;
