"""Build reviewed PostgreSQL companions from additive SQLite migrations. No database connection."""
from pathlib import Path
import re
root = Path(__file__).resolve().parents[2]
server = root / 'server'
out = Path(__file__).resolve().parent
for filename, versions in [('000-prerequisite-community.sql', [112, 113]), ('20261112001700_admin_completion.sql', [114, 115, 116, 117])]:
    sql = '\n'.join(next((server / 'migrations').glob(f'{v:03d}_*.sql')).read_text() for v in versions)
    # These additive migrations contain portable CHECK/REFERENCES/INDEX definitions and epoch-millisecond integer columns.
    sql = re.sub(r'\bINTEGER\b', 'bigint', sql)
    tables = re.findall(r'CREATE TABLE\s+([a-z_]+)', sql)
    security = []
    for table in tables:
        security.append(f'''ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {table} FORCE ROW LEVEL SECURITY;
REVOKE ALL ON {table} FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO meldiq_api;
CREATE POLICY trusted_backend ON {table} FOR ALL TO meldiq_api USING (true) WITH CHECK (true);''')
    (out / filename).write_text('-- Reviewed additive candidate. Apply in one transaction after validating the prerequisite schema.\nSET LOCAL search_path = meldiq, public;\n' + sql + '\n' + '\n'.join(security) + '\n')
print('Prepared PostgreSQL SQL companions; no database modified.')
