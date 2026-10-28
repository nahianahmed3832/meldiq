import { BSON } from "mongodb";
import type { DB } from "../db.js";
import { indexesFor, type TableDomain, type TableSpec, toDocument } from "./catalog.js";
import type { MeldiqMongo } from "./client.js";
import { sourceBatches } from "./migrate.js";

/**
 * How much storage a migration would take, measured before anything is copied (docs/MONGODB.md › Capacity). Atlas Free
 * clusters stop at 0.5 GB, counted as uncompressed BSON plus index bytes; a copy that runs out of room halfway is a
 * failed write freeze. Each source row is measured as the document it becomes (`toDocument`) with its index entries,
 * and a migration starts only while the projected usage leaves headroom. Sizes only: no content is read out.
 */

/** Bytes per index entry beyond its key (record id and B-tree bookkeeping): an estimate that errs high. */
const INDEX_ENTRY_OVERHEAD_BYTES = 16;
/** A copy starts only while the projected usage stays under this share of the limit, leaving room to keep running. */
export const CAPACITY_HEADROOM = 0.7;
const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);
const MIB = 1024 * 1024;
const ESTIMATE_BATCH = 5000;

export interface TableEstimate {
  table: string;
  domain: TableDomain;
  rows: number;
  dataBytes: number;
  indexBytes: number;
}

export interface StorageEstimate {
  tables: TableEstimate[];
  dataBytes: number;
  indexBytes: number;
  totalBytes: number;
}

export interface CapacityCheck {
  limitBytes: number;
  /** What the deployment holds now (every database this user can see). */
  usedBytes: number;
  /** The part of [usedBytes] a re-run replaces instead of adding (documents already copied). */
  replacedBytes: number;
  projectedBytes: number;
  allowedBytes: number;
  ok: boolean;
}

interface IndexShape {
  fields: string[];
  /** Fields that must be set for a document to have an entry (partial indexes). */
  requires: string[];
}

function indexShapes(t: TableSpec): IndexShape[] {
  return [
    { fields: ["_id"], requires: [] },
    ...indexesFor(t).map((ix) => ({ fields: Object.keys(ix.key), requires: Object.keys(ix.partialFilterExpression ?? {}) })),
  ];
}

function estimateTable(db: DB, t: TableSpec): TableEstimate {
  const shapes = indexShapes(t);
  let rows = 0;
  let dataBytes = 0;
  let indexBytes = 0;
  for (const batch of sourceBatches(db, t, ESTIMATE_BATCH, null)) {
    for (const row of batch) {
      const doc = toDocument(t, row);
      rows++;
      dataBytes += BSON.calculateObjectSize(doc);
      for (const ix of shapes) {
        if (ix.requires.some((f) => doc[f] === null)) continue;
        indexBytes += BSON.calculateObjectSize(Object.fromEntries(ix.fields.map((f) => [f, doc[f]]))) + INDEX_ENTRY_OVERHEAD_BYTES;
      }
    }
  }
  return { table: t.name, domain: t.domain, rows, dataBytes, indexBytes };
}

/** The documents and index entries [tables] would become in MongoDB. Reads SQLite only. */
export function estimateStorage(db: DB, tables: TableSpec[]): StorageEstimate {
  const estimates = tables.map((t) => estimateTable(db, t));
  const dataBytes = estimates.reduce((n, t) => n + t.dataBytes, 0);
  const indexBytes = estimates.reduce((n, t) => n + t.indexBytes, 0);
  return { tables: estimates, dataBytes, indexBytes, totalBytes: dataBytes + indexBytes };
}

/**
 * Whether copying [estimate] fits: current usage, minus what a re-run overwrites (a table's documents already present,
 * pro rata), plus the estimate, must stay under the headroom share of the limit.
 */
export function checkCapacity(limitBytes: number, usedBytes: number, estimate: StorageEstimate, existingDocs: ReadonlyMap<string, number>): CapacityCheck {
  const replacedBytes = estimate.tables.reduce((n, t) => {
    if (t.rows === 0) return n;
    const share = Math.min(1, (existingDocs.get(t.table) ?? 0) / t.rows);
    return n + (t.dataBytes + t.indexBytes) * share;
  }, 0);
  const projectedBytes = Math.max(usedBytes - replacedBytes, 0) + estimate.totalBytes;
  const allowedBytes = limitBytes * CAPACITY_HEADROOM;
  return { limitBytes, usedBytes, replacedBytes, projectedBytes, allowedBytes, ok: projectedBytes <= allowedBytes };
}

/** Bytes the deployment's databases hold now, as Atlas counts them (uncompressed data plus indexes). */
export async function deploymentUsageBytes(mongo: MeldiqMongo): Promise<number> {
  const { databases } = (await mongo.client.db("admin").command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true })) as {
    databases: { name: string }[];
  };
  let total = 0;
  for (const { name } of databases) {
    if (SYSTEM_DATABASES.has(name)) continue;
    const stats = (await mongo.client.db(name).stats()) as { dataSize?: number; indexSize?: number };
    total += (stats.dataSize ?? 0) + (stats.indexSize ?? 0);
  }
  return total;
}

/** [checkCapacity] against the live deployment, for copying [estimate] into [mongo]'s database. */
export async function projectCapacity(mongo: MeldiqMongo, estimate: StorageEstimate, limitBytes: number): Promise<CapacityCheck> {
  const existing = new Map<string, number>();
  for (const t of estimate.tables) existing.set(t.table, await mongo.db.collection(t.table).estimatedDocumentCount());
  return checkCapacity(limitBytes, await deploymentUsageBytes(mongo), estimate, existing);
}

export const mib = (bytes: number): string => `${(bytes / MIB).toFixed(2)} MiB`;

export function describeCapacity(c: CapacityCheck): string {
  const verdict = c.ok ? "fits" : "DOES NOT FIT";
  return `storage: ${mib(c.usedBytes)} used now, ${mib(c.projectedBytes)} projected, limit ${mib(c.limitBytes)} (a copy starts only below ${mib(c.allowedBytes)}): ${verdict}`;
}
