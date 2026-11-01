import { validateAuditChain } from "../src/modules/platformAdmin/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { describeTables } from "../src/infrastructure/database/mongo/catalog.js";
import {
  mongoConfig,
  MONGO_DOMAINS,
} from "../src/infrastructure/database/mongo/config.js";
import { MeldiqMongo } from "../src/infrastructure/database/mongo/client.js";
import {
  authorityOf,
  migrateToMongo,
  setAuthority,
  verify,
} from "../src/infrastructure/database/mongo/migrate.js";
import {
  validateRelationships,
} from "../src/infrastructure/database/mongo/validate.js";
import { loadConfig } from "../src/app/config.js";
import { buildApp } from "../src/app/server.js";

/** All production records stay in encrypted files or a mode-0700 temporary LOCAL replica set. No production writes. */
const backupDir = process.argv[2];
const reportFile = process.argv[3];
if (!backupDir || !reportFile)
  throw new Error(
    "Usage: tsx scripts/rehearse-database.ts <encrypted-backup-dir> <aggregate-report.json>",
  );
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-restore-"));
fs.chmodSync(temporary, 0o700);
let replica: MongoMemoryReplSet | undefined,
  mongo: MeldiqMongo | undefined,
  db: Database.Database | undefined;
const report: Record<string, unknown> = {
  productionWrites: false,
  startedAt: new Date().toISOString(),
};
function writeReport() {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
}
async function main() {
  replica = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    instanceOpts: [
      { ip: "127.0.0.1", args: ["--wiredTigerCacheSizeGB", "0.25"] },
    ],
  });
  const uri = replica.getUri();
  const dbName = `meldiq_restore_${Date.now()}`;
  const decrypt = spawn(
    "age",
    [
      "--decrypt",
      "-i",
      path.join(backupDir, "restore-key.agekey"),
      path.join(backupDir, "atlas.ejson.gz.age"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const restore = spawn(
    process.execPath,
    ["scripts/database-backup.mjs", "restore"],
    {
      env: {
        ...process.env,
        RESTORE_MONGODB_URI: uri,
        RESTORE_MONGODB_DB: dbName,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let restoreSummary = "";
  restore.stdout.on("data", (x) => (restoreSummary += x));
  restore.stderr.resume();
  decrypt.stderr.resume();
  const restored = once(restore, "exit"),
    decrypted = once(decrypt, "exit");
  decrypt.stdout.pipe(restore.stdin);
  if ((await decrypted)[0] !== 0 || (await restored)[0] !== 0)
    throw new Error("Encrypted Atlas restore failed");
  report.backupRestore = JSON.parse(restoreSummary);
  writeReport();
  const file = path.join(temporary, "source.sqlite");
  const fd = fs.openSync(file, "w", 0o600);
  const sqlite = spawn(
    "age",
    [
      "--decrypt",
      "-i",
      path.join(backupDir, "restore-key.agekey"),
      path.join(backupDir, "sqlite.snapshot.age"),
    ],
    { stdio: ["ignore", fd, "pipe"] },
  );
  sqlite.stderr.resume();
  if ((await once(sqlite, "exit"))[0] !== 0)
    throw new Error("Encrypted SQLite restore failed");
  fs.closeSync(fd);
  db = new Database(file, { readonly: true, fileMustExist: true });
  report.sqliteIntegrity = db.pragma("quick_check", { simple: true });
  if (report.sqliteIntegrity !== "ok")
    throw new Error("SQLite restore integrity failure");
  const config = mongoConfig(
    { MONGODB_URI: uri, MONGODB_DB: dbName },
    "development",
    (_n, d) => d,
  )!;
  mongo = await MeldiqMongo.connect(config, []);
  const tables = describeTables(db);
  const pending = [];
  const excluded = [];
  for (const t of tables) {
    if (
      t.domain === "integrations" ||
      (await authorityOf(mongo, t.domain)) === "mongodb"
    )
      excluded.push(t.name);
    else pending.push(t);
  }
  report.excludedAlreadyAuthoritative = excluded;
  if (!process.argv.includes("--memory-probe"))
    report.preflight = await verify(db, mongo, pending);
  writeReport();
  await mongo.ensureSchema(pending);
  // Rehearsal only: preserve both existing conflicting Atlas versions in the archive, then use SQLite's declared ownership.
  report.copy = await migrateToMongo(db, mongo, pending, {
    batchSize: process.argv.includes("--memory-probe") ? 5000 : 500,
    conflictPolicy: "archive",
  });
  writeReport();
  if (!process.argv.includes("--memory-probe"))
    report.idempotency = await migrateToMongo(db, mongo, pending, {
      batchSize: 500,
    });
  for (const domain of new Set(pending.map((t) => t.domain)))
    await setAuthority(
      mongo,
      domain,
      "mongodb",
      "local restored-backup rehearsal only",
    );
  report.relationships = await validateRelationships(mongo.db, tables);
  report.auditChain = await validateAuditChain(mongo.db);
  report.archivedConflicts = await mongo.db
    .collection("database_migration_conflicts")
    .countDocuments();
  writeReport();
  const domains = MONGO_DOMAINS.join(",");
  const appConfig = loadConfig({
    MONGODB_URI: uri,
    MONGODB_DB: dbName,
    MONGODB_DOMAINS: domains,
    DATABASE_MODE: "atlas",
    DATA_DIR: temporary,
    LOG_LEVEL: "silent",
    TELEMETRY_TICK_MS: "0",
    REMINDER_TICK_MS: "0",
    WORKFLOW_TICK_MS: "0",
  });
  const collect = async () => {
    for (let i = 0; i < 3; i++) {
      (globalThis as { gc?: () => void }).gc?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await collect();
  report.memoryBeforeApp = process.memoryUsage();
  const app = await buildApp(appConfig, { logger: false });
  try {
    const health = await app.app.inject({ url: "/healthz" });
    const info = await app.app.inject({ url: "/v1/server-info" });
    await collect();
    report.garbageCollectionAvailable =
      typeof (globalThis as { gc?: unknown }).gc === "function";
    report.application = {
      health: health.statusCode,
      serverInfo: info.statusCode,
      persistentSqliteOpened: fs.existsSync(appConfig.databasePath),
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      domains: [...app.ctx.mongo!.config.domains],
    };
  } finally {
    await app.app.close();
    app.ctx.db.close();
  }
  report.finishedAt = new Date().toISOString();
  report.rehearsalComplete = true;
  writeReport();
}
main()
  .catch((error) => {
    report.rehearsalComplete = false;
    report.failure = {
      type: error.name,
      message: "Local rehearsal failed; production remains unchanged",
    };
    writeReport();
    process.exitCode = 1;
  })
  .finally(async () => {
    db?.close();
    await mongo?.close();
    await replica?.stop({ doCleanup: true, force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  });
