-- Historical intervals retain frequency 1. No financial agreement or amount is changed.
ALTER TABLE billing_plan_versions ADD COLUMN billing_frequency INTEGER NOT NULL DEFAULT 1 CHECK (billing_frequency BETWEEN 1 AND 12);
CREATE TRIGGER billing_plan_frequency_frozen BEFORE UPDATE OF billing_frequency ON billing_plan_versions
WHEN OLD.published_at IS NOT NULL AND NEW.billing_frequency IS NOT OLD.billing_frequency
BEGIN SELECT RAISE(ABORT, 'a published plan version is immutable'); END;
