ALTER TABLE org_role_extras ADD COLUMN icon_expression_id TEXT REFERENCES community_expressions(id) ON DELETE SET NULL;
