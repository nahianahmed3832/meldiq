-- 2026-10-25: a monthly AI budget per installed agent, set by the community (docs/implementation/PROGRESS.md, phase 10).
-- Additive only. NULL: no budget of its own (the platform's quotas still apply). Spend is read from ai_usage, which
-- already records the installation of every agent request.
ALTER TABLE ai_agent_installs ADD COLUMN max_cost_micro_month INTEGER;
CREATE INDEX idx_ai_usage_install ON ai_usage(install_id, at);
