import fs from "node:fs";
import path from "node:path";
import { openPostgresRuntime } from "../src/app/postgresRuntime.js";
import { MeldiqPostgres } from "../src/infrastructure/database/postgres/client.js";
import { postgresTableSpecs } from "../src/infrastructure/database/postgres/nativeCatalog.js";
import { tableCounts } from "../src/infrastructure/database/postgres/migration.js";

/** Opens the actual repository composition on an already validated OWNED loopback copy. No API or jobs start. */
async function main() {
  const [snapshot, output] = process.argv.slice(2);
  if (!snapshot || !output) throw new Error("Private normalized snapshot and aggregate report path required");
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, "manifest.json"), "utf8"));
  const proof = JSON.parse(fs.readFileSync(path.join(snapshot, "local-validation.json"), "utf8"));
  if (
    !manifest.realDataSnapshot ||
    manifest.synthetic ||
    !/^[a-f0-9-]{36}$/.test(manifest.id) ||
    !proof.ok ||
    !proof.allRecordHashesMatch ||
    proof.sourceSha256 !== manifest.sourceSha256 ||
    proof.catalogSha256 !== manifest.catalogSha256
  )
    throw new Error("Exact successful owned local rehearsal required");
  const database = `meldiq_customer_rehearsal_${manifest.id.replaceAll("-", "")}`;
  if (proof.database !== database) throw new Error("Owned database receipt mismatch");
  const db = new MeldiqPostgres({
    url: `postgresql://postgres@127.0.0.1:55432/${database}`,
    environment: "development",
    maxConnections: 3,
  });
  let runtime: Awaited<ReturnType<typeof openPostgresRuntime>> | undefined;
  const report = {
    observedAt: new Date().toISOString(),
    ok: false,
    synthetic: false,
    scope: "Repository bootstrap on an owned MacBook loopback clone; no HTTP server, Auth provider, external clients or delivery/cleanup jobs",
    sourceSha256: manifest.sourceSha256,
    catalogSha256: manifest.catalogSha256,
    sourceAndHostedDestinationChanged: false,
  } as Record<string, unknown>;
  try {
    const run = (await db.query("SELECT source_sha256,catalog_sha256 FROM meldiq_private.migration_runs WHERE id=$1", [manifest.id])).rows[0];
    if (run?.source_sha256 !== manifest.sourceSha256 || run?.catalog_sha256 !== manifest.catalogSha256) throw new Error("Owned database source fingerprint mismatch");
    const start = performance.now();
    runtime = await openPostgresRuntime(db);
    report.bootstrapMilliseconds = performance.now() - start;
    report.residentMemoryBytes = process.memoryUsage().rss;
    report.heapUsedBytes = process.memoryUsage().heapUsed;
    const counts = await tableCounts(db, postgresTableSpecs());
    for (const table of manifest.tables) if (counts.get(table.name) !== table.count) throw new Error("Repository bootstrap count mismatch");
    for (const spec of postgresTableSpecs()) if (runtime.rows.has(spec.name) && runtime.rows.count(spec.name) !== counts.get(spec.name)) throw new Error("Cached repository bootstrap mismatch");
    report.applicationTables = counts.size;
    report.records = [...counts.values()].reduce((sum, count) => sum + count, 0);
    report.cachedDomainsMatchDatabaseCounts = true;
    report.legacySqlAttempts = runtime.legacySqlAttempts;
    report.ok = true;
  } finally {
    try {
      await runtime?.close();
    } catch {
      report.ok = false;
      report.closeFailed = true;
    }
    try {
      await db.close();
    } catch {
      report.ok = false;
      report.closeFailed = true;
    }
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(() => {
  console.error("Owned snapshot repository bootstrap stopped; source and hosted destination were not modified");
  process.exitCode = 1;
});
