import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import crypto from "node:crypto";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { postgresTableSpecs } from "../src/infrastructure/database/postgres/nativeCatalog.js";

/** Audit source references and release constraints using only an in-memory schema; no customer database access. */
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
const source = openDatabase(":memory:");
const reviewedTriggerHashes: Record<string, string> = {
  billing_plan_versions_frozen: "48fe826bbac385eea8258d0ed3f1198df530be70da034f0b92986ae77013473a",
  platform_audit_no_delete: "7b8296518543acd1fbae19ab296120a19080d6b79709a36fa0c7f35fadc4750f",
  platform_audit_no_update: "934c7eea2c2f87667eb728b9f9b2050f62d8cf8b951de93618712fe08bdc1e14",
  billing_plan_frequency_frozen: "17a2cc415039011ba9f8549b65cbbaf9bcb8accf0ca224b55a34a29ba6dadb13",
};
const sourceTriggers = (source.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as {name: string; sql: string}[]).map(trigger => {
  const sha256 = crypto.createHash("sha256").update(trigger.sql).digest("hex");
  return {name: trigger.name, sha256, preservedBy: reviewedTriggerHashes[trigger.name] === sha256 ? trigger.name === "billing_plan_frequency_frozen" ? "20261103001300_current_production_fields.sql" : "20261102001000_immutable_audit_and_prices.sql" : null};
});
source.close();
const unreviewedTriggers = sourceTriggers.filter(trigger => !trigger.preservedBy);
const report = {observedAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  sourceWorkingTreeHasChanges: !!execFileSync("git", ["status", "--porcelain=1", "--", "src"], {encoding: "utf8"}).trim(),
  scope: "Static Mongo collection() references and exact reviewed source trigger hashes. Dynamic catalog/DocumentStore factories require separate explicit model and repository review.",
  modeledTables: models.size, literalReferences: literals, dynamicReferencesRequiringReview: dynamic, unclassified,
  sourceTriggers, unreviewedTriggers,
  customerRecordsRead: 0, productionChanged: false, ok: unclassified.length === 0 && unreviewedTriggers.length === 0};
fs.mkdirSync(path.dirname(path.resolve(output)), {recursive: true});
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({modeledTables: models.size, literalReferences: literals.length, dynamicReferences: dynamic.length, unclassified: unclassified.length, ok: report.ok}));
if (!report.ok) process.exitCode = 1;
