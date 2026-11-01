import crypto from "node:crypto";
import { Binary, type AnyBulkWriteOperation, type Document } from "mongodb";
import type { DB } from "../db.js";
import { type TableDomain, type TableSpec, toDocument, toRow } from "./catalog.js";
import { META_COLLECTION, type MeldiqMongo } from "./client.js";

/**
 * Moving tables between SQLite and MongoDB (docs/MONGODB.md › Migration). Copies in primary-key order, in batches, with
 * a checkpoint after each batch, so an interrupted run resumes where it stopped; every write is an upsert by `_id`, so a
 * re-run never duplicates anything. Verification compares counts, the sets of ids and an order-independent checksum of
 * every row's canonical form: no content is ever printed or logged, only counts and checksums.
 */

export interface TableReport {
  table: string;
  domain: TableDomain;
  sourceCount: number;
  destCount: number;
  copied: number;
  /** Actual destination document writes; unchanged records are scanned but never rewritten. */
  written?: number;
  /** Ids in the destination that the source doesn't have (removed with prune). */
  extra: number;
  /** Ids in the source that the destination doesn't have. */
  missing: number;
  /** Rows present on both sides whose content differs. */
  differing: number;
  sourceChecksum: string;
  destChecksum: string;
  ok: boolean;
  ms: number;
}

export interface MigrateOptions {
  batchSize?: number;
  /** Read/check a larger bounded window while keeping actual writes paced in batchSize chunks. */
  readBatchSize?: number;
  /** Optional pacing after a batch that wrote documents, for small shared clusters. */
  batchDelayMs?: number;
  /** Explicit review: archive conflicting destination versions before replacing them from the authoritative source. */
  conflictPolicy?: "reject" | "archive";
  /** Remove destination documents the source doesn't have (a re-run after rows were deleted). */
  prune?: boolean;
  onProgress?: (table: string, copied: number, total: number) => void;
  onWriteProgress?: (table: string, written: number, total: number) => void;
}

interface Checkpoint {
  _id: string;
  table: string;
  lastKey: unknown[] | null;
  copied: number;
  startedAt: number;
  finishedAt: number | null;
}

const DEFAULT_BATCH = 500;
const VERIFY_BATCH = 5000;

/** Canonical text of a document: keys sorted at every level, binary as base64, so both sides hash alike. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Buffer.isBuffer(v)) return JSON.stringify({ $b64: v.toString("base64") });
  if (v instanceof Binary) return JSON.stringify({ $b64: Buffer.from(v.buffer).toString("base64") });
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const rowHash = (doc: Record<string, unknown>): Buffer => crypto.createHash("sha256").update(canonical(doc)).digest();

/** Order-independent checksum: the sum of every row's SHA-256 modulo 2^256 (same rows, same sum, in any order). */
class SetChecksum {
  private sum = 0n;
  private static readonly MOD = 1n << 256n;
  add(h: Buffer): void {
    this.sum = (this.sum + BigInt(`0x${h.toString("hex")}`)) % SetChecksum.MOD;
  }
  hex(): string {
    return this.sum.toString(16).padStart(64, "0");
  }
}

function selectColumns(t: TableSpec): string {
  return (t.primaryKey.length ? "" : "rowid, ") + t.columns.map((c) => `"${c.name}"`).join(", ");
}

function keyColumns(t: TableSpec): string[] {
  return t.primaryKey.length ? t.primaryKey : ["rowid"];
}

/** Rows of [t] in key order, [batch] at a time, after [after] (keyset pagination). */
export function* sourceBatches(db: DB, t: TableSpec, batch: number, after: unknown[] | null): Generator<Record<string, unknown>[]> {
  const keys = keyColumns(t);
  const keyList = keys.map((k) => (k === "rowid" ? "rowid" : `"${k}"`)).join(", ");
  const order = `ORDER BY ${keyList}`;
  const first = db.prepare(`SELECT ${selectColumns(t)} FROM "${t.name}" ${order} LIMIT ?`);
  const next = db.prepare(`SELECT ${selectColumns(t)} FROM "${t.name}" WHERE (${keyList}) > (${keys.map(() => "?").join(", ")}) ${order} LIMIT ?`);
  let last = after;
  for (;;) {
    const rows = (last ? next.all(...last, batch) : first.all(batch)) as Record<string, unknown>[];
    if (rows.length === 0) return;
    yield rows;
    const tail = rows[rows.length - 1];
    last = keys.map((k) => tail[k]);
    if (rows.length < batch) return;
  }
}

/**
 * Copies [tables] from SQLite into MongoDB, resuming from each table's checkpoint, then verifies them. A table whose
 * checkpoint says it finished is scanned again from the start, writing only missing or changed documents. A final
 * pass still requires a write freeze and an immutable snapshot; pre-copy never transfers authority by itself.
 */
export async function migrateToMongo(db: DB, mongo: MeldiqMongo, tables: TableSpec[], opts: MigrateOptions = {}): Promise<TableReport[]> {
  const batch = opts.batchSize ?? DEFAULT_BATCH;
  if (!Number.isInteger(batch) || batch < 1 || batch > 10_000) throw new Error("Migration batchSize must be an integer between 1 and 10000");
  const readBatch = opts.readBatchSize ?? batch;
  if (!Number.isInteger(readBatch) || readBatch < 1 || readBatch > 10_000) throw new Error("Migration readBatchSize must be an integer between 1 and 10000");
  const delay = opts.batchDelayMs ?? 0;
  if (!Number.isInteger(delay) || delay < 0 || delay > 60_000) throw new Error("Migration batchDelayMs must be an integer between 0 and 60000");
  // An old SQLite copy must never replace records already accepted by Atlas after cutover.
  for (const domain of new Set(tables.map((t) => t.domain))) {
    if (await authorityOf(mongo, domain) === "mongodb") throw new Error(`Refusing SQLite migration: ${domain} is already authoritative in MongoDB`);
  }
  const preflight = await verify(db, mongo, tables);
  if (preflight.some(r => r.differing > 0) && opts.conflictPolicy !== "archive") {
    throw new Error("Destination conflicts require review and conflictPolicy=archive; nothing was copied");
  }
  for (const t of tables) {
    const report = preflight.find(r => r.table === t.name)!;
    if (report.differing || (report.extra && opts.prune)) await archiveConflicts(db, mongo, t, opts);
  }
  const meta = mongo.db.collection<Checkpoint>(META_COLLECTION);
  const reports: TableReport[] = [];
  for (const t of tables) {
    const started = Date.now();
    const cpId = `migration:${t.name}`;
    const cp = await meta.findOne({ _id: cpId });
    const resumeFrom = cp && cp.finishedAt === null ? cp.lastKey : null;
    let copied = resumeFrom ? cp!.copied : 0;
    let written = 0;
    await meta.updateOne(
      { _id: cpId },
      { $set: { table: t.name, startedAt: resumeFrom ? cp!.startedAt : started, finishedAt: null, ...(resumeFrom ? {} : { lastKey: null, copied: 0 }) } },
      { upsert: true },
    );
    const total = (db.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as { n: number }).n;
    const col = mongo.db.collection<Document>(t.name);
    for (const rows of sourceBatches(db, t, readBatch, resumeFrom)) {
      const documents = rows.map((r) => toDocument(t, r));
      // The lookup is limited to one source batch. Atlas Free counts bulk document writes against its throughput
      // allowance: blindly replacing every unchanged telemetry sample would make the final write freeze much longer.
      const existing = new Map((await col.find({ _id: { $in: documents.map(d => d._id) as never[] } }, { batchSize: readBatch }).toArray())
        .map(d => [canonical(d._id), rowHash({ ...toDocument(t, toRow(t, d)), _id: d._id })]));
      const ops: AnyBulkWriteOperation<Document>[] = documents
        .filter(d => !existing.get(canonical(d._id))?.equals(rowHash(d)))
        .map(d => ({ replaceOne: { filter: { _id: d._id as never }, replacement: d, upsert: true } }));
      for (let offset = 0; offset < ops.length; offset += batch) {
        const chunk = ops.slice(offset, offset + batch);
        await col.bulkWrite(chunk, { ordered: false });
        written += chunk.length;
        opts.onWriteProgress?.(t.name, written, total);
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      }
      copied += rows.length;
      const tail = rows[rows.length - 1];
      await meta.updateOne({ _id: cpId }, { $set: { lastKey: keyColumns(t).map((k) => tail[k]), copied } });
      opts.onProgress?.(t.name, copied, total);
    }
    // Deleted AUTOINCREMENT rows still reserve their IDs. The schema scaffold is empty in Atlas-only runtime.
    // Rows uses `value`; the encrypted relay's allocator uses `seq`. Preserve both high-water conventions.
    if (t.autoincrement) {
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(t.name) as { seq: number } | undefined;
      const floor = sequence?.seq ?? 0;
      await mongo.db.collection<{ _id: string }>(META_COLLECTION).updateOne(
        { _id: `seq:${t.name}` }, { $max: { value: floor, seq: floor } }, { upsert: true },
      );
    }
    if (opts.prune) await pruneExtra(db, mongo, t, opts);
    const [report] = await verify(db, mongo, [t]);
    await meta.updateOne({ _id: cpId }, { $set: report.ok ? { finishedAt: Date.now() } : { finishedAt: null, lastKey: null, copied: 0 } });
    reports.push({ ...report, copied, written, ms: Date.now() - started });
  }
  return reports;
}

/** A bounded indexed lookup by the ORIGINAL destination _id; malformed IDs never bind as SQL objects. */
function sourceLookup(db: DB, t: TableSpec): (id: unknown) => Record<string, unknown> | undefined {
  const keys = keyColumns(t);
  const stmt = db.prepare(`SELECT ${selectColumns(t)} FROM "${t.name}" WHERE ${keys.map(k => `"${k}" = ?`).join(" AND ")}`);
  return (id) => {
    const values = keys.length === 1 ? [id] : keys.map(k => id && typeof id === "object" ? (id as Record<string, unknown>)[k] : undefined);
    if (values.some(v => !(typeof v === "string" || typeof v === "number" || Buffer.isBuffer(v)))) return undefined;
    return stmt.get(...values) as Record<string, unknown> | undefined;
  };
}

/** Preserves target versions using a deterministic content-addressed ID, before any reviewed replacement or pruning. */
async function archiveConflicts(db: DB, mongo: MeldiqMongo, table: TableSpec, opts: MigrateOptions): Promise<void> {
  const lookup = sourceLookup(db, table);
  const archive = mongo.db.collection<Document>("database_migration_conflicts");
  let operations: AnyBulkWriteOperation<Document>[] = [];
  const flush = async () => {
    if (!operations.length) return;
    await archive.bulkWrite(operations, { ordered: false });
    operations = [];
    if (opts.batchDelayMs) await new Promise(resolve => setTimeout(resolve, opts.batchDelayMs));
  };
  for await (const document of mongo.db.collection<Document>(table.name).find({}, { batchSize: VERIFY_BATCH })) {
    const source = lookup(document._id);
    const target = { ...toDocument(table, toRow(table, document)), _id: document._id };
    if (source && rowHash(toDocument(table, source)).equals(rowHash(target))) continue;
    const checksum = rowHash(document).toString("hex");
    const id = `${table.name}:${checksum}`;
    operations.push({ updateOne: { filter: { _id: id as never }, update: { $setOnInsert: { collection: table.name, domain: table.domain, checksum, archivedAt: Date.now(), original: document } }, upsert: true } });
    if (operations.length >= (opts.batchSize ?? DEFAULT_BATCH)) await flush();
  }
  await flush();
}

/** Deletes in bounded batches; it never keeps the full source or destination ID set in RAM. */
async function pruneExtra(db: DB, mongo: MeldiqMongo, t: TableSpec, opts: MigrateOptions): Promise<number> {
  const lookup = sourceLookup(db, t);
  const col = mongo.db.collection<Document>(t.name);
  let extra: unknown[] = [];
  let count = 0;
  for await (const d of col.find({}, { projection: { _id: 1 }, batchSize: VERIFY_BATCH })) {
    if (!lookup(d._id)) extra.push(d._id);
    if (extra.length >= (opts.batchSize ?? DEFAULT_BATCH)) { await col.deleteMany({ _id: { $in: extra as never[] } }); count += extra.length; extra = []; if (opts.batchDelayMs) await new Promise(resolve => setTimeout(resolve, opts.batchDelayMs)); }
  }
  if (extra.length) { await col.deleteMany({ _id: { $in: extra as never[] } }); count += extra.length; }
  return count;
}

/** Counts, original IDs, timestamps and deterministic content hashes; memory bounded by a cursor batch. */
export async function verify(db: DB, mongo: Pick<MeldiqMongo, "db">, tables: TableSpec[]): Promise<TableReport[]> {
  const out: TableReport[] = [];
  for (const t of tables) {
    const started = Date.now();
    const sourceSum = new SetChecksum();
    let sourceCount = 0;
    for (const rows of sourceBatches(db, t, VERIFY_BATCH, null)) for (const r of rows) { sourceCount++; sourceSum.add(rowHash(toDocument(t, r))); }
    const lookup = sourceLookup(db, t);
    const destSum = new SetChecksum();
    let destCount = 0, matched = 0, extra = 0, differing = 0;
    for await (const d of mongo.db.collection<Document>(t.name).find({}, { batchSize: VERIFY_BATCH })) {
      destCount++;
      const doc = { ...toDocument(t, toRow(t, d)), _id: d._id };
      const hash = rowHash(doc);
      destSum.add(hash);
      const source = lookup(d._id);
      if (!source) extra++;
      else { matched++; if (!rowHash(toDocument(t, source)).equals(hash)) differing++; }
    }
    const missing = Math.max(0, sourceCount - matched);
    out.push({ table: t.name, domain: t.domain, sourceCount, destCount, copied: 0, extra, missing, differing,
      sourceChecksum: sourceSum.hex(), destChecksum: destSum.hex(),
      ok: sourceCount === destCount && extra === 0 && missing === 0 && differing === 0 && sourceSum.hex() === destSum.hex(), ms: Date.now() - started });
  }
  return out;
}

/**
 * Rollback: replaces [tables] in SQLite with MongoDB's documents, in one SQLite transaction, then checks foreign keys.
 * The caller backs the SQLite file up first (admin.ts does); MongoDB is only read. Children of the domain are written
 * after their parents, and foreign keys are checked at the end, so a dangling reference aborts the whole restore.
 */
export async function exportToSqlite(mongo: MeldiqMongo, db: DB, tables: TableSpec[]): Promise<TableReport[]> {
  const docs = new Map<string, Record<string, unknown>[]>();
  for (const t of tables) docs.set(t.name, (await mongo.db.collection<Document>(t.name).find({}).toArray()) as Record<string, unknown>[]);
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const t of [...tables].reverse()) db.prepare(`DELETE FROM "${t.name}"`).run();
      for (const t of tables) {
        const cols = [...(t.primaryKey.length ? [] : ["rowid"]), ...t.columns.map((c) => c.name)];
        const ins = db.prepare(`INSERT INTO "${t.name}" (${cols.map((c) => (c === "rowid" ? "rowid" : `"${c}"`)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
        for (const d of docs.get(t.name)!) {
          const row = toRow(t, d);
          ins.run(...cols.map((c) => row[c] as never));
        }
      }
      const broken = tables.flatMap((t) => db.pragma(`foreign_key_check("${t.name}")`) as unknown[]);
      if (broken.length) throw new Error(`Restore would leave ${broken.length} broken reference(s); nothing was changed`);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return verify(db, mongo, tables);
}

export type Authority = "sqlite" | "mongodb";

/** Which store is authoritative for [domain], as recorded in MongoDB (null: never migrated). */
export async function authorityOf(mongo: MeldiqMongo, domain: string): Promise<Authority | null> {
  const d = await mongo.db.collection<{ _id: string; store: Authority }>(META_COLLECTION).findOne({ _id: `authority:${domain}` });
  return d?.store ?? null;
}

export async function setAuthority(mongo: MeldiqMongo, domain: string, store: Authority, detail: string): Promise<void> {
  await mongo.db
    .collection<{ _id: string }>(META_COLLECTION)
    .updateOne({ _id: `authority:${domain}` }, { $set: { store, at: Date.now(), detail } }, { upsert: true });
}
