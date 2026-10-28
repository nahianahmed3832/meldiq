import fs from "node:fs";
import path from "node:path";
import { backupDatabase } from "../../../modules/administration/backup.js";
import type { Config } from "../../../app/config.js";
import { type DB, openDatabase } from "../db.js";
import { CAPACITY_HEADROOM, describeCapacity, estimateStorage, mib, projectCapacity } from "./capacity.js";
import { describeTables, EXCLUDED_TABLES, type TableSpec } from "./catalog.js";
import { domainTables, MeldiqMongo } from "./client.js";
import { MONGO_DOMAINS, type MongoDomain, redactUri } from "./config.js";
import { authorityOf, exportToSqlite, migrateToMongo, setAuthority, type TableReport, verify } from "./migrate.js";

/**
 * Operator commands for MongoDB (docs/MONGODB.md). They print counts, sizes and checksums only, never row content.
 *
 *   mongo-status                       connection, transactions, which store holds each domain, row counts on both sides
 *   mongo-estimate [--domain <d>] [--snapshot <file>] [--limit-mb <n>]
 *                                      the storage the tables would take in MongoDB (SQLite only, no connection);
 *                                      exit 1 when it passes 70% of the limit (MONGODB_STORAGE_LIMIT_MB by default)
 *   mongo-migrate <domain> --yes       back up SQLite, copy the domain to MongoDB, verify, then make MongoDB its home
 *                                      (stop the API first: the write freeze). Re-run safe; --prune drops stale copies
 *   mongo-verify <domain|--all>        compare SQLite and MongoDB (counts, ids, checksums)
 *   mongo-rollback <domain> --yes      back up SQLite, copy the domain back from MongoDB, verify, make SQLite its home
 *   mongo-dryrun [--snapshot <file>] [--db <name>] [--keep]
 *                                      copy every table of a snapshot (or this database) into a throwaway database
 *                                      (meldiq_dryrun_<time>, or one the user is granted), twice, and verify both runs;
 *                                      dropped unless --keep
 *
 * With MONGODB_STORAGE_LIMIT_MB set, mongo-migrate and mongo-dryrun refuse before copying when the projected usage would
 * pass 70% of it (an Atlas Free cluster holds 512 MiB).
 */
export const MONGO_COMMANDS = ["mongo-status", "mongo-estimate", "mongo-migrate", "mongo-verify", "mongo-rollback", "mongo-dryrun"];

const MIB = 1024 * 1024;
const DB_NAME = /^[A-Za-z0-9_-]{1,38}$/;

function optionValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

/** False (after saying why) when copying [tables] into [mongo] would pass the configured storage limit. */
async function capacityAllows(cfg: Config, source: DB, mongo: MeldiqMongo, tables: TableSpec[]): Promise<boolean> {
  const limitMb = cfg.mongo?.storageLimitMb ?? 0;
  if (limitMb <= 0) return true;
  const check = await projectCapacity(mongo, estimateStorage(source, tables), limitMb * MIB);
  console.log(describeCapacity(check));
  if (!check.ok) console.log("Nothing was copied. Free space in the deployment, migrate fewer domains, or use a larger cluster.");
  return check.ok;
}

function printReports(reports: TableReport[]): boolean {
  console.table(
    reports.map((r) => ({
      table: r.table,
      domain: r.domain,
      sqlite: r.sourceCount,
      mongodb: r.destCount,
      missing: r.missing,
      extra: r.extra,
      differing: r.differing,
      checksum: r.sourceChecksum === r.destChecksum ? r.sourceChecksum.slice(0, 16) : "MISMATCH",
      ok: r.ok,
    })),
  );
  const ok = reports.every((r) => r.ok);
  console.log(ok ? "verified: every table matches" : "NOT verified: see the rows marked ok=false");
  return ok;
}

/**
 * Empties a throwaway database collection by collection: a least-privilege user (`readWrite` on it, as on Atlas) may drop
 * collections but not the database itself. A database left without collections disappears on its own.
 */
async function dropAllCollections(mongo: MeldiqMongo): Promise<void> {
  const collections = await mongo.db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) await mongo.db.collection(name).drop();
}

function domainArg(arg: string | undefined): MongoDomain {
  if (!arg || !(MONGO_DOMAINS as readonly string[]).includes(arg)) {
    throw new Error(`name a domain: ${MONGO_DOMAINS.join(", ")}`);
  }
  return arg as MongoDomain;
}

/** A snapshot of the SQLite file next to it, before anything changes (never overwrites). */
async function backupFirst(cfg: Config, db: DB, label: string): Promise<string> {
  const dir = path.join(path.dirname(cfg.databasePath), "backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${label}-${new Date().toISOString().replace(/[:.]/g, "")}.sqlite`);
  await backupDatabase(db, file);
  console.log(`SQLite backed up to ${file}`);
  return file;
}

async function connect(cfg: Config, tables: TableSpec[], dbName?: string): Promise<MeldiqMongo> {
  if (!cfg.mongo) throw new Error("MONGODB_URI is not set");
  return MeldiqMongo.connect(dbName ? { ...cfg.mongo, dbName } : cfg.mongo, tables);
}

export async function runMongoCommand(cmd: string, rest: string[], cfg: Config, db: DB): Promise<number> {
  const yes = rest.includes("--yes");
  switch (cmd) {
    case "mongo-status": {
      if (!cfg.mongo) {
        console.log("MongoDB: not configured (MONGODB_URI unset); every table is in SQLite");
        return 0;
      }
      const mongo = await connect(cfg, domainTables(db, cfg.mongo.domains));
      try {
        console.log(`MongoDB: ${redactUri(cfg.mongo.uri)} database ${cfg.mongo.dbName}; transactions: ${mongo.supportsTransactions}`);
        // Round trips from this machine (every account request makes one or two): check before moving a domain.
        const rtts: number[] = [];
        for (let i = 0; i < 10; i++) {
          const t0 = performance.now();
          await mongo.ping();
          rtts.push(performance.now() - t0);
        }
        rtts.sort((a, b) => a - b);
        console.log(`round trip: median ${rtts[5].toFixed(1)} ms, slowest ${rtts[9].toFixed(1)} ms (10 pings)`);
        const rows = [];
        for (const domain of MONGO_DOMAINS) {
          const tables = domainTables(db, [domain]);
          for (const t of tables) {
            rows.push({
              domain,
              configured: cfg.mongo.domains.has(domain) ? "mongodb" : "sqlite",
              recorded: (await authorityOf(mongo, domain)) ?? "-",
              table: t.name,
              sqlite: (db.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as { n: number }).n,
              mongodb: await mongo.db.collection(t.name).estimatedDocumentCount(),
            });
          }
        }
        console.table(rows);
      } finally {
        await mongo.close();
      }
      return 0;
    }
    case "mongo-verify": {
      const tables = rest[0] === "--all" ? describeTables(db) : domainTables(db, [domainArg(rest[0])]);
      const mongo = await connect(cfg, []);
      try {
        return printReports(await verify(db, mongo, tables)) ? 0 : 1;
      } finally {
        await mongo.close();
      }
    }
    case "mongo-migrate": {
      const domain = domainArg(rest[0]);
      if (!yes) {
        console.log(`Would copy ${domain} to MongoDB and make it the home of that data. Stop the API first, then re-run with --yes.`);
        return 2;
      }
      const tables = domainTables(db, [domain]);
      const mongo = await connect(cfg, tables);
      try {
        if (!(await capacityAllows(cfg, db, mongo, tables))) return 1;
        await backupFirst(cfg, db, `pre-mongo-${domain}`);
        const reports = await migrateToMongo(db, mongo, tables, {
          prune: rest.includes("--prune"),
          onProgress: (t, n, total) => process.stdout.write(`\r${t}: ${n}/${total}   `),
        });
        process.stdout.write("\n");
        if (!printReports(reports)) {
          console.log("MongoDB was NOT made the home of this data. Make sure nothing writes (API stopped) and run it again.");
          return 1;
        }
        await setAuthority(mongo, domain, "mongodb", `migrated ${reports.reduce((n, r) => n + r.sourceCount, 0)} rows`);
        console.log(`${domain} now lives in MongoDB. Add it to MONGODB_DOMAINS and start the API. SQLite keeps its copy, unchanged, for rollback.`);
        return 0;
      } finally {
        await mongo.close();
      }
    }
    case "mongo-rollback": {
      const domain = domainArg(rest[0]);
      if (!yes) {
        console.log(`Would replace SQLite's ${domain} tables with MongoDB's (after a backup). Stop the API first, then re-run with --yes.`);
        return 2;
      }
      const tables = domainTables(db, [domain]);
      const mongo = await connect(cfg, tables);
      try {
        await backupFirst(cfg, db, `pre-rollback-${domain}`);
        if (!printReports(await exportToSqlite(mongo, db, tables))) return 1;
        await setAuthority(mongo, domain, "sqlite", "rolled back");
        console.log(`${domain} is back in SQLite. Remove it from MONGODB_DOMAINS before starting the API. MongoDB keeps its copy.`);
        return 0;
      } finally {
        await mongo.close();
      }
    }
    case "mongo-estimate": {
      const snapshot = optionValue(rest, "--snapshot");
      const source = snapshot ? openDatabase(snapshot) : db;
      const domain = optionValue(rest, "--domain");
      const tables = domain ? domainTables(source, [domainArg(domain)]) : describeTables(source);
      const limitMb = Number(optionValue(rest, "--limit-mb") ?? cfg.mongo?.storageLimitMb ?? 0);
      if (!Number.isFinite(limitMb) || limitMb < 0) throw new Error("--limit-mb takes a size in MiB");
      const estimate = estimateStorage(source, tables);
      console.table(
        estimate.tables
          .filter((t) => t.rows > 0)
          .sort((a, b) => b.dataBytes + b.indexBytes - (a.dataBytes + a.indexBytes))
          .map((t) => ({ table: t.table, domain: t.domain, rows: t.rows, data: mib(t.dataBytes), indexes: mib(t.indexBytes) })),
      );
      const rows = estimate.tables.reduce((n, t) => n + t.rows, 0);
      console.log(`${tables.length} tables, ${rows} rows: ${mib(estimate.dataBytes)} documents + ${mib(estimate.indexBytes)} indexes = ${mib(estimate.totalBytes)}`);
      console.log(`not copied (by design): ${Object.keys(EXCLUDED_TABLES).join(", ")}`);
      if (limitMb === 0) return 0;
      const allowed = limitMb * MIB * CAPACITY_HEADROOM;
      const fits = estimate.totalBytes <= allowed;
      console.log(`limit ${mib(limitMb * MIB)}: ${fits ? "fits" : "DOES NOT FIT"} below ${mib(allowed)} (plus whatever the deployment already holds)`);
      return fits ? 0 : 1;
    }
    case "mongo-dryrun": {
      const snapshot = optionValue(rest, "--snapshot");
      const source = snapshot ? openDatabase(snapshot) : db;
      const tables = describeTables(source);
      const dbName = optionValue(rest, "--db") ?? `meldiq_dryrun_${Date.now().toString(36)}`;
      if (!DB_NAME.test(dbName)) throw new Error("--db may only use letters, digits, _ and - (at most 38)");
      if (dbName === cfg.mongo?.dbName) throw new Error("--db must not be the server's own database");
      console.log(`Dry run into ${dbName}; not copied (by design): ${Object.keys(EXCLUDED_TABLES).join(", ")}`);
      const mongo = await connect(cfg, tables, dbName);
      try {
        if (!(await capacityAllows(cfg, source, mongo, tables))) {
          await dropAllCollections(mongo);
          return 1;
        }
        const first = await migrateToMongo(source, mongo, tables);
        const okFirst = printReports(first);
        console.log("Second run (must change nothing):");
        const second = await migrateToMongo(source, mongo, tables);
        const okSecond = printReports(second);
        const same = second.every((r, k) => r.destChecksum === first[k].destChecksum && r.destCount === first[k].destCount);
        console.log(same ? "re-run: identical" : "re-run: DIFFERENT");
        if (!rest.includes("--keep")) await dropAllCollections(mongo);
        return okFirst && okSecond && same ? 0 : 1;
      } finally {
        await mongo.close();
      }
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}
