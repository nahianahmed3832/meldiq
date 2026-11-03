import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { BSON } from "mongodb";
import { postgresTableSpecs } from "../src/infrastructure/database/postgres/nativeCatalog.js";
import { exactBson, normalizeSourceDocument } from "../src/infrastructure/database/postgres/sourceSnapshot.js";
import { digest } from "../src/infrastructure/database/postgres/migration.js";

const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const MOD = 1n << 256n;
const hex = (value: bigint) => value.toString(16).padStart(64, "0");
async function main() {
  process.umask(0o077);
  const [encrypted, identity, output, frozenReceipt] = process.argv.slice(2);
  if (!encrypted || !identity || !output || !path.isAbsolute(output)) throw new Error("Private encrypted input, identity and new absolute output directory required");
  for (const file of [encrypted, identity]) if (!fs.statSync(file).isFile() || fs.statSync(file).mode & 0o077) throw new Error("Private input permissions required");
  let capture:any;
  if(frozenReceipt){
    const stat=fs.lstatSync(frozenReceipt);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error("Private frozen capture receipt required");
    capture=JSON.parse(fs.readFileSync(frozenReceipt,"utf8"));
    const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(encrypted))hash.update(chunk);
    if(!capture.ok||!capture.sourceReadOnly||capture.sourceRemainsLive||!capture.sourceWritesFrozen||!capture.pointInTimeSnapshot||capture.ciphertextSha256!==hash.digest("hex")||!capture.freezeProof?.ok||!capture.freezeProof.sourceWritesFrozen||capture.freezeProof.productionAuthorityChanged||!/^\/opt\/griip-internal-messaging\/database-migration\/postgres-cutover-\d{8}T\d{6}Z$/.test(capture.freezeProof.runDirectory))throw new Error("Verified frozen-source capture required");
  }
  fs.mkdirSync(output, {mode: 0o700});
  const specs = postgresTableSpecs();
  const tables = new Map(specs.map(spec => [spec.name, {spec, count: 0, hash: crypto.createHash("sha256")} ]));
  for (const spec of specs) fs.writeFileSync(path.join(output, `${spec.name}.ndjson`), "", {mode: 0o600, flag: "wx"});
  const stats = new Map<string, {count: number; sum: bigint}>();
  const problems = new Map<string, number>();
  const counters: Record<string, number> = {};
  const archiveNames = new Set(["orbit_meta", "database_migration_conflicts", "billing_checkouts_pre_paypal_20261101", "mojo_gifts_pre_paypal_20261101", "database_migration_original_platform_audit_20261102"]);
  const problem = (table: string, code: string) => { const key = `${table}:${code}`; problems.set(key, (problems.get(key) ?? 0) + 1); };
  let header: any, complete: any, stream: fs.WriteStream | undefined, current = "";
  const child = spawn("age", ["-d", "-i", identity, encrypted], {stdio: ["ignore", "pipe", "ignore"]});
  const exited = once(child, "close");
  try {
    const input = readline.createInterface({input: child.stdout.pipe(createGunzip()), crlfDelay: Infinity});
    for await (const line of input) {
      if (complete) throw new Error("Trailing snapshot content");
      const record = JSON.parse(line);
      if (record.type === "header") {
        if (header || record.format !== "meldiq-ejson-snapshot-v1") throw new Error("Invalid source format");
        header = record;
        for (const definition of header.collections) {
          if (!/^[a-z][a-z0-9_]*$/.test(definition.name) || stats.has(definition.name)) throw new Error("Invalid source inventory");
          stats.set(definition.name, {count: 0, sum: 0n});
          if (!tables.has(definition.name) && !archiveNames.has(definition.name)) problem(definition.name, "unmapped_collection");
        }
      } else if (record.type === "document" && header) {
        const source = stats.get(record.collection);
        if (!source || typeof record.ejson !== "string") throw new Error("Unknown source document");
        source.count++; source.sum = (source.sum + BigInt("0x" + digest(JSON.stringify(stable(JSON.parse(record.ejson)))))) % MOD;
        const table = tables.get(record.collection);
        if (!table) {
          if (record.collection === "orbit_meta") {
            const doc = exactBson(BSON.EJSON.parse(record.ejson, {relaxed: false})) as Record<string, unknown>;
            if (typeof doc._id === "string" && doc._id.startsWith("seq:")) {
              const name = doc._id.slice(4);
              const values = [doc.seq, doc.value].filter(value => value !== undefined);
              const value = values.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ? Math.max(...values as number[]) : NaN;
              const spec = tables.get(name)?.spec;
              if (!spec || !(spec.autoincrement || !spec.primaryKey.length) || !Number.isSafeInteger(value) || Number(value) < 0) problem("orbit_meta", "unmapped_counter");
              else counters[name] = Number(value);
            }
          }
          continue;
        }
        try {
          const row = normalizeSourceDocument(table.spec, record.ejson);
          const text = JSON.stringify(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? {$binary: value.toString("base64")} : value]))) + "\n";
          if (current !== record.collection) {
            if (stream) { stream.end(); await once(stream, "finish"); }
            current = record.collection; stream = fs.createWriteStream(path.join(output, `${current}.ndjson`), {flags: "a", mode: 0o600});
          }
          table.hash.update(text); table.count++;
          if (!stream!.write(text)) await once(stream!, "drain");
        } catch (error) {
          const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "row_validation_failed";
          problem(record.collection, code);
        }
      } else if (record.type === "complete" && header) complete = record;
      else throw new Error("Invalid snapshot content");
    }
    if (stream) { stream.end(); await once(stream, "finish"); stream = undefined; }
    if ((await exited)[0] !== 0 || !complete || !complete.snapshotTime || complete.totals.length !== stats.size) throw new Error("Incomplete immutable snapshot");
    if(capture&&(capture.snapshotTime!==complete.snapshotTime||!Number.isFinite(Date.parse(capture.freezeProof.frozenAt))||Date.parse(header.createdAt)<Date.parse(capture.freezeProof.frozenAt)))throw new Error("Snapshot does not follow the verified source freeze");
    for (const expected of complete.totals) {
      const actual = stats.get(expected.collection);
      if (!actual || actual.count !== expected.count || hex(actual.sum) !== expected.checksum) throw new Error("Source backup checksum mismatch");
    }
    const report = {ok: problems.size === 0, observedAt: new Date().toISOString(), sourceCollections: stats.size,
      sourceRecords: [...stats.values()].reduce((sum, value) => sum + value.count, 0),
      normalizedTables: specs.length, normalizedRecords: [...tables.values()].reduce((sum, value) => sum + value.count, 0),
      sourceChecksumsVerified: true, productionChanged: false, destinationImported: false,
      issues: Object.fromEntries(problems), archivedCollections: [...archiveNames].map(name => ({name, records: stats.get(name)?.count ?? 0, retainedInEncryptedSource: true})), counters: Object.keys(counters).length};
    fs.writeFileSync(path.join(output, "normalization-report.json"), JSON.stringify(report, null, 2) + "\n", {mode: 0o600});
    if (report.ok) {
      const files = [...tables].map(([name, table]) => ({name, count: table.count, sha256: table.hash.digest("hex")}));
      const manifest = {id: crypto.randomUUID(), frozen: true, synthetic: false, realDataSnapshot: true, purpose: capture?"production-cutover":"staging-rehearsal", sourceWritesFrozen: !!capture,
        sourceKind: "mongo-atlas-snapshot", createdAt: new Date().toISOString(), snapshotTime: complete.snapshotTime,
        catalogSha256: digest(JSON.stringify(specs)), sourceSha256: digest(JSON.stringify(files)), tables: files, counters,
        excludedCollections: report.archivedCollections,...(capture?{freezeProof:capture.freezeProof,sourceCiphertextSha256:capture.ciphertextSha256}:{})};
      fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {mode: 0o600, flag: "wx"});
    }
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } finally { stream?.destroy(); if (child.exitCode === null) child.kill(); }
}
main().catch(() => { console.error("Snapshot normalization stopped. Private incomplete output retained; do not import it."); process.exitCode = 1; });
