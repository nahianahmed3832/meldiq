import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { postgresTableSpecs } from "../src/infrastructure/database/postgres/nativeCatalog.js";

/** Compare source references, not just collections which happen to contain live data. No database connection. */
const output = process.argv[2];
if (!output) throw new Error("Usage: tsx scripts/supabase-audit-native.ts <evidence-json>");
const models = new Set(postgresTableSpecs().map(table => table.name));
const archival = new Set(["database_migration_conflicts"]);
const literals: {collection: string; file: string; line: number; disposition: string}[] = [];
const dynamic: {file: string; line: number}[] = [];
const files = execFileSync("rg", ["--files", "src", "-g", "*.ts"], {encoding: "utf8"}).trim().split("\n").sort();
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "collection") {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const name = node.arguments[0];
      if (name && ts.isStringLiteral(name)) literals.push({collection: name.text, file, line,
        disposition: models.has(name.text) ? "relational model" : archival.has(name.text) ? "legacy migration evidence retained" : "UNMAPPED"});
      else dynamic.push({file, line});
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const unclassified = literals.filter(reference => reference.disposition === "UNMAPPED");
const report = {observedAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  sourceWorkingTreeHasChanges: !!execFileSync("git", ["status", "--porcelain=1", "--", "src"], {encoding: "utf8"}).trim(),
  scope: "Static Mongo collection() references only. Dynamic catalog/DocumentStore factories require separate explicit model and repository review.",
  modeledTables: models.size, literalReferences: literals, dynamicReferencesRequiringReview: dynamic, unclassified,
  customerRecordsRead: 0, productionChanged: false, ok: unclassified.length === 0};
fs.mkdirSync(path.dirname(path.resolve(output)), {recursive: true});
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({modeledTables: models.size, literalReferences: literals.length, dynamicReferences: dynamic.length, unclassified: unclassified.length, ok: report.ok}));
if (!report.ok) process.exitCode = 1;
