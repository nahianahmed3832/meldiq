/** Reproducible relational migration from the inspected release; no business data is read. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { describeTables } from "../src/infrastructure/database/mongo/catalog.js";

const root = process.argv[2];
if (!root) throw new Error("Usage: tsx scripts/supabase-schema.ts /absolute/web/root");
const db = openDatabase(":memory:");
const tables = describeTables(db);
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const ident = (s: string) => s.length <= 63 ? s : `${s.slice(0, 50)}_${crypto.createHash("sha256").update(s).digest("hex").slice(0, 12)}`;
const sqlType = (t: string) => ({ TEXT: "text", INTEGER: "bigint", REAL: "double precision", BLOB: "bytea" })[t] ?? (() => { throw new Error(`Unsupported type ${t}`); })();
const checks = (sql: string): string[] => {
  const result: string[] = [];
  const re = /\bCHECK\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    let level = 1, quote = false, i = re.lastIndex;
    const start = i;
    for (; i < sql.length && level; i++) {
      if (sql[i] === "'") {
        if (quote && sql[i + 1] === "'") { i++; continue; }
        quote = !quote;
      }
      if (!quote) { if (sql[i] === "(") level++; if (sql[i] === ")") level--; }
    }
    if (level) throw new Error("Unbalanced CHECK");
    result.push(sql.slice(start, i - 1));
    re.lastIndex = i;
  }
  return result;
};
const catalog = tables.map(t => ({ ...t, checks: checks((db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t.name) as { sql: string }).sql) }));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const manifest = { sourceCommit, sourceSchema: db.prepare("SELECT max(version) AS version FROM schema_migrations").get(), tables: catalog };
const lines = [
  "-- Generated from release " + sourceCommit + "; do not edit by hand.",
  "-- Epoch-millisecond columns preserve the released UTC/API contract. New operational time columns use timestamptz.",
  "CREATE SCHEMA meldiq;",
  "CREATE SCHEMA meldiq_private;",
  "REVOKE ALL ON SCHEMA meldiq, meldiq_private FROM PUBLIC, anon, authenticated;",
  "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'meldiq_api') THEN CREATE ROLE meldiq_api NOLOGIN NOBYPASSRLS; END IF; END $$;",
  "GRANT USAGE ON SCHEMA meldiq, meldiq_private TO meldiq_api;",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA meldiq, meldiq_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
];
for (const t of catalog) {
  const cols = t.columns.map(c => {
    let def = "";
    if (c.default !== undefined) {
      if (typeof c.default === "object" && c.default !== null) throw new Error(`Expression default requires review: ${t.name}.${c.name}`);
      def = ` DEFAULT ${c.default === null ? "NULL" : typeof c.default === "string" ? `'${c.default.replaceAll("'", "''")}'` : c.default}`;
    }
    return `  ${q(c.name)} ${sqlType(c.type)}${c.notNull || t.primaryKey.includes(c.name) ? " NOT NULL" : ""}${def}`;
  });
  if (!t.primaryKey.length) cols.push('  "rowid" bigint NOT NULL PRIMARY KEY');
  else cols.push(`  PRIMARY KEY (${t.primaryKey.map(q).join(", ")})`);
  for (const c of t.checks) cols.push(`  CHECK (${c})`);
  lines.push(`CREATE TABLE meldiq.${q(t.name)} (\n${cols.join(",\n")}\n);`);
  for (const ix of t.indexes) {
    const columns = ix.columns.map(c => ix.nocase || t.columns.find(col => col.name === c)?.nocase
      ? `(translate(${q(c)}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))` : q(c));
    lines.push(`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${q(ident(`${t.name}_${ix.name}`))} ON meldiq.${q(t.name)} (${columns.join(", ")})${ix.partialNotNull ? ` WHERE ${ix.partialNotNull.map(c => `${q(c)} IS NOT NULL`).join(" AND ")}` : ""};`);
  }
  lines.push(`ALTER TABLE meldiq.${q(t.name)} ENABLE ROW LEVEL SECURITY;`, `ALTER TABLE meldiq.${q(t.name)} FORCE ROW LEVEL SECURITY;`,
    `REVOKE ALL ON meldiq.${q(t.name)} FROM PUBLIC, anon, authenticated;`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON meldiq.${q(t.name)} TO meldiq_api;`,
    `CREATE POLICY trusted_backend ON meldiq.${q(t.name)} FOR ALL TO meldiq_api USING (true) WITH CHECK (true);`);
}
for (const t of catalog) for (const [i, fk] of t.foreignKeys.entries()) {
  if (!catalog.some(p => p.name === fk.table)) throw new Error(`Unmapped FK ${t.name} -> ${fk.table}`);
  lines.push(`ALTER TABLE meldiq.${q(t.name)} ADD CONSTRAINT ${q(ident(`${t.name}_fk_${i}`))} FOREIGN KEY (${fk.columns.map(q).join(", ")}) REFERENCES meldiq.${q(fk.table)} (${fk.references.map(q).join(", ")}) ON DELETE ${fk.onDelete} DEFERRABLE INITIALLY DEFERRED;`);
}
const dir = path.join(root, "supabase");
fs.mkdirSync(path.join(dir, "generated"), { recursive: true });
fs.writeFileSync(path.join(dir, "generated", "source-catalog.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(dir, "migrations", "20261102000100_release_relations.sql"), lines.join("\n") + "\n");
const types = catalog.map(t => `  ${q(t.name)}: {\n${t.columns.map(c => `    ${q(c.name)}: ${c.type === "TEXT" ? "string" : c.type === "BLOB" ? "Uint8Array" : "number"}${!c.notNull && !t.primaryKey.includes(c.name) ? " | null" : ""};`).join("\n")}\n  };`).join("\n");
fs.writeFileSync(path.join(dir, "generated", "database.types.ts"), `// Generated from ${sourceCommit}; wire epoch timestamps are UTC milliseconds.\nexport interface MeldiqRows {\n${types}\n}\n`);
db.close();
console.log(JSON.stringify({ sourceCommit, tables: catalog.length, columns: catalog.reduce((n, t) => n + t.columns.length, 0), foreignKeys: catalog.reduce((n,t) => n+t.foreignKeys.length,0), checks: catalog.reduce((n,t) => n+t.checks.length,0) }));
