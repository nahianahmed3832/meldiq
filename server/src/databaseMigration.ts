import { mongoConfig } from "./infrastructure/database/mongo/config.js";
import Database from "better-sqlite3";
import { MongoClient } from "mongodb";
import {
  describeTables,
  tableSpecs,
  toDocument,
} from "./infrastructure/database/mongo/catalog.js";
import {
  authorityOf,
  sourceBatches,
  verify,
} from "./infrastructure/database/mongo/migrate.js";
import {
  validateRelationships,
} from "./infrastructure/database/mongo/validate.js";
import { MeldiqMongo } from "./infrastructure/database/mongo/client.js";
import { migrateToMongo } from "./infrastructure/database/mongo/migrate.js";
import { estimateStorage, projectCapacity } from "./infrastructure/database/mongo/capacity.js";

/** Diagnostics are read-only. Copy/schema changes require --apply; no command starts application workers. */
async function main() {
  const [command, sourceFile] = process.argv.slice(2);
  if (!["plan", "preflight", "validate", "indexes", "copy"].includes(command))
    throw new Error(
      "Use plan <snapshot.sqlite>, preflight <snapshot.sqlite>, validate, copy <snapshot.sqlite> --apply, or indexes --apply",
    );
  if (command !== "plan") required("MONGODB_URI");
  const production = [process.env.NODE_ENV, process.env.APP_ENV].some(value => value?.trim() === "production");
  const settings = command === "plan" ? null : mongoConfig(process.env, production ? "production" : "development", (name, fallback) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value)) throw new Error("MongoDB numeric configuration must contain integers");
    return value;
  });
  if (["copy", "indexes"].includes(command) && !process.argv.includes("--apply"))
    throw new Error("Copy/schema changes require --apply");
  if (["plan", "preflight", "copy"].includes(command) && (!sourceFile || sourceFile.startsWith("--")))
    throw new Error("An immutable SQLite snapshot path is required");
  const source = ["plan", "preflight", "copy"].includes(command)
    ? new Database(sourceFile, { readonly: true, fileMustExist: true })
    : null;
  const client =
    command === "plan"
      ? null
      : new MongoClient(settings!.uri, {
          maxPoolSize: Math.min(settings!.maxPoolSize, 4),
          serverSelectionTimeoutMS: settings!.timeoutMs,
          connectTimeoutMS: settings!.timeoutMs,
        });
  try {
    if (source && source.pragma("quick_check", { simple: true }) !== "ok")
      throw new Error("Source integrity check failed");
    const tables = source ? describeTables(source) : tableSpecs();
    if (command === "plan") {
      const configured = new Set(
        process.env.MONGODB_DOMAINS?.split(",").map((d) => d.trim()),
      );
      console.log(
        JSON.stringify({
          readOnly: true,
          tables: tables.map((t) => ({
            table: t.name,
            domain: t.domain,
            sourceCount: (
              source!.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as {
                n: number;
              }
            ).n,
            candidate: !configured.has(t.domain) && t.domain !== "integrations",
            references: t.foreignKeys.map((f) => f.table),
          })),
        }),
      );
      return;
    }
    await client!.connect();
    const db = client!.db(settings!.dbName);
    if (command === "preflight" || command === "copy") {
      const candidates = [],
        excluded = [];
      const configured = new Set(
        process.env.MONGODB_DOMAINS?.split(",").map((d) => d.trim()),
      );
      for (const t of tables) {
        const authority = await authorityOf({ db } as MeldiqMongo, t.domain);
        if (
          configured.has(t.domain) ||
          authority === "mongodb" ||
          t.domain === "integrations"
        )
          excluded.push({
            table: t.name,
            domain: t.domain,
            reason: "already authoritative in Atlas or retired",
          });
        else candidates.push(t);
      }
      if (command === "copy") {
        if (production && settings!.storageLimitMb <= 0) throw new Error("Production copy requires MONGODB_STORAGE_LIMIT_MB");
        const mongo = await MeldiqMongo.connect(settings!, candidates);
        try {
          const capacity = settings!.storageLimitMb > 0 ? await projectCapacity(mongo, estimateStorage(source!, candidates), settings!.storageLimitMb * 1024 * 1024) : null;
          if (capacity && !capacity.ok) throw new Error("Migration capacity safety threshold exceeded");
          const value = (flag: string, fallback: number) => {
            const i = process.argv.indexOf(flag);
            return i < 0 ? fallback : Number(process.argv[i + 1]);
          };
          const reports = await migrateToMongo(source!, mongo, candidates, {
            batchSize: value("--batch-size", 50),
            readBatchSize: value("--read-batch-size", 5000),
            batchDelayMs: value("--batch-delay-ms", 1000),
            conflictPolicy: process.argv.includes("--archive-conflicts") ? "archive" : "reject",
            prune: process.argv.includes("--prune"),
            onProgress: (table, scanned, total) => console.error(JSON.stringify({ table, scanned, total })),
            onWriteProgress: (table, written, total) => console.error(JSON.stringify({ table, written, total })),
          });
          const ok = reports.every(r => r.ok);
          console.log(JSON.stringify({ authorityChanged: false, excluded, capacity, reports, ok }));
          if (!ok) process.exitCode = 2;
        } finally { await mongo.close(); }
        return;
      }
      // Source transformation errors are counted without logging a document or its sensitive fields.
      let transformed = 0,
        rejected = 0;
      for (const t of candidates)
        for (const batch of sourceBatches(source!, t, 500, null))
          for (const row of batch) {
            try {
              toDocument(t, row);
              transformed++;
            } catch {
              rejected++;
            }
          }
      const reports = await verify(source!, { db }, candidates);
      const conflicts = reports.reduce((n, r) => n + r.extra + r.differing, 0);
      console.log(
        JSON.stringify({
          readOnly: true,
          transformed,
          rejected,
          conflicts,
          excluded,
          reports,
          ready: rejected === 0 && conflicts === 0,
        }),
      );
      if (rejected || conflicts) process.exitCode = 2;
    } else if (command === "validate") {
      const { validateAuditChain } = await import("./modules/platformAdmin/auditValidation.js");
      const relationships = await validateRelationships(db, tables);
      const audit = await validateAuditChain(db);
      const missing = relationships.reduce((n, r) => n + r.missing, 0);
      console.log(
        JSON.stringify({
          readOnly: true,
          relationships,
          audit,
          ok: missing === 0 && audit.ok,
        }),
      );
      if (missing || !audit.ok) process.exitCode = 2;
    } else {
      if (!process.argv.includes("--apply"))
        throw new Error(
          "Index/schema changes require indexes --apply with a migration credential",
        );
      // Schema preparation runs only on this explicit path, not on any diagnostic command.
      const mongo = await MeldiqMongo.connect(
        settings!,
        tables.filter((t) => t.domain !== "integrations"),
      );
      await mongo.close();
      console.log(JSON.stringify({ schemaPrepared: true }));
    }
  } finally {
    source?.close();
    await client?.close();
  }
}
function required(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      errorType: error instanceof Error ? error.name : "Error",
      message:
        "Database operation failed; inspect access, source integrity and configuration securely",
    }),
  );
  process.exitCode = 1;
});
