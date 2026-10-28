import crypto from "node:crypto";
import { Binary, type AnyBulkWriteOperation, type Document } from "mongodb";
import type { DB } from "../db.js";
import { docId, type TableDomain, type TableSpec, toDocument, toRow } from "./catalog.js";
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
  /** Remove destination documents the source doesn't have (a re-run after rows were deleted). */
  prune?: boolean;
  onProgress?: (table: string, copied: number, total: number) => void;
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

function idKey(id: unknown): string {
  return canonical(id);
}

/**
 * Copies [tables] from SQLite into MongoDB, resuming from each table's checkpoint, then verifies them. A table whose
 * checkpoint says it finished is copied again from the start (cheap upserts), so a re-run also picks up rows written
 * since; run it during the write freeze for the final pass.
 */
export async function migrateToMongo(db: DB, mongo: MeldiqMongo, tables: TableSpec[], opts: MigrateOptions = {}): Promise<TableReport[]> {
  const batch = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const meta = mongo.db.collection<Checkpoint>(META_COLLECTION);
  const reports: TableReport[] = [];
  for (const t of tables) {
    const started = Date.now();
    const cpId = `migration:${t.name}`;
    const cp = await meta.findOne({ _id: cpId });
    const resumeFrom = cp && cp.finishedAt === null ? cp.lastKey : null;
    let copied = resumeFrom ? cp!.copied : 0;
    await meta.updateOne(
      { _id: cpId },
      { $set: { table: t.name, startedAt: resumeFrom ? cp!.startedAt : started, finishedAt: null, ...(resumeFrom ? {} : { lastKey: null, copied: 0 }) } },
      { upsert: true },
    );
    const total = (db.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as { n: number }).n;
    const col = mongo.db.collection<Document>(t.name);
    for (const rows of sourceBatches(db, t, batch, resumeFrom)) {
      const ops: AnyBulkWriteOperation<Document>[] = rows.map((r) => ({
        replaceOne: { filter: { _id: docId(t, r) as never }, replacement: toDocument(t, r), upsert: true },
      }));
      await col.bulkWrite(ops, { ordered: false });
      copied += rows.length;
      const tail = rows[rows.length - 1];
      await meta.updateOne({ _id: cpId }, { $set: { lastKey: keyColumns(t).map((k) => tail[k]), copied } });
      opts.onProgress?.(t.name, copied, total);
    }
    if (opts.prune) await pruneExtra(db, mongo, t);
    await meta.updateOne({ _id: cpId }, { $set: { finishedAt: Date.now() } });
    const [report] = await verify(db, mongo, [t]);
    reports.push({ ...report, copied, ms: Date.now() - started });
  }
  return reports;
}

/** Removes destination documents whose id the source no longer has. */
async function pruneExtra(db: DB, mongo: MeldiqMongo, t: TableSpec): Promise<number> {
  const source = new Set<string>();
  for (const rows of sourceBatches(db, t, 5000, null)) for (const r of rows) source.add(idKey(docId(t, r)));
  const col = mongo.db.collection<Document>(t.name);
  const extra: unknown[] = [];
  for await (const d of col.find({}, { projection: { _id: 1 } })) if (!source.has(idKey(d._id))) extra.push(d._id);
  for (let i = 0; i < extra.length; i += 1000) await col.deleteMany({ _id: { $in: extra.slice(i, i + 1000) as never[] } });
  return extra.length;
}

/** Compares SQLite and MongoDB for [tables]: counts, id sets, per-row content and the set checksums. */
export async function verify(db: DB, mongo: MeldiqMongo, tables: TableSpec[]): Promise<TableReport[]> {
  const out: TableReport[] = [];
  for (const t of tables) {
    const started = Date.now();
    const sourceSum = new SetChecksum();
    const sourceRows = new Map<string, string>();
    for (const rows of sourceBatches(db, t, 5000, null)) {
      for (const r of rows) {
        const doc = toDocument(t, r);
        const h = rowHash(doc);
        sourceSum.add(h);
        sourceRows.set(idKey(doc._id), h.toString("hex"));
      }
    }
    const destSum = new SetChecksum();
    let destCount = 0;
    let extra = 0;
    let differing = 0;
    const seen = new Set<string>();
    for await (const d of mongo.db.collection<Document>(t.name).find({})) {
      destCount++;
      // The document as the source would produce it (drops anything not in the table, normalises binary).
      const doc = toDocument(t, toRow(t, d));
      const h = rowHash(doc);
      destSum.add(h);
      const k = idKey(doc._id);
      seen.add(k);
      const s = sourceRows.get(k);
      if (s === undefined) extra++;
      else if (s !== h.toString("hex")) differing++;
    }
    const missing = [...sourceRows.keys()].filter((k) => !seen.has(k)).length;
    out.push({
      table: t.name,
      domain: t.domain,
      sourceCount: sourceRows.size,
      destCount,
      copied: 0,
      extra,
      missing,
      differing,
      sourceChecksum: sourceSum.hex(),
      destChecksum: destSum.hex(),
      ok: extra === 0 && missing === 0 && differing === 0 && sourceSum.hex() === destSum.hex(),
      ms: Date.now() - started,
    });
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
