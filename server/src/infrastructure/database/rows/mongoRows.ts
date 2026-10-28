import type { AnyBulkWriteOperation, Document } from "mongodb";
import type { DB } from "../db.js";
import { docId, type TableSpec, toDocument, toRow } from "../mongo/catalog.js";
import { META_COLLECTION, type MeldiqMongo } from "../mongo/client.js";
import { MemoryRows, type PersistedChanges } from "./memory.js";
import type { Row } from "./types.js";

/** orbit_meta document holding an AUTOINCREMENT table's last id (ids are never reused, as in SQLite). */
const counterId = (table: string) => `seq:${table}`;

/**
 * Rows whose durable home is MongoDB: loaded into memory at start (synchronous reads, SQLite semantics, memory.ts), and
 * every write unit committed in one MongoDB transaction before memory changes. Documents have the migration's shape
 * (catalog.ts › toDocument), so migrated documents and new ones are alike.
 */
export class MongoRows extends MemoryRows {
  readonly backend = "mongodb" as const;
  private readonly specs: Map<string, TableSpec>;

  private constructor(
    private readonly mongo: MeldiqMongo,
    specs: TableSpec[],
    private readonly sqlite?: { db: DB; log?: { error(obj: object, msg?: string): void } },
  ) {
    super(specs);
    this.specs = new Map(specs.map((s) => [s.name, s]));
  }

  /**
   * Loads [specs]' collections into memory. With [sqlite], SQL a unit runs for other domains (still in SQLite) runs in
   * one SQLite transaction, committed just before the unit's MongoDB transaction.
   */
  static async open(mongo: MeldiqMongo, specs: TableSpec[], sqlite?: { db: DB; log?: { error(obj: object, msg?: string): void } }): Promise<MongoRows> {
    const rows = new MongoRows(mongo, specs, sqlite);
    await rows.loadAll();
    return rows;
  }

  private async loadAll(): Promise<void> {
    for (const spec of this.specs.values()) {
      for await (const doc of this.mongo.db.collection<Document>(spec.name).find({})) {
        const row = toRow(spec, doc as Record<string, unknown>);
        if (spec.primaryKey.length === 0) {
          const rowid = Number(row.rowid);
          delete row.rowid;
          this.load(spec.name, row, rowid);
        } else this.load(spec.name, row);
      }
    }
    const counters = await this.mongo.db
      .collection<{ _id: string; value: number }>(META_COLLECTION)
      .find({ _id: { $in: [...this.specs.keys()].map(counterId) } })
      .toArray();
    for (const c of counters) this.bumpCounter(c._id.slice("seq:".length), c.value);
  }

  protected override runUnit<T>(fn: () => T): T {
    return this.sqlite ? this.sqlite.db.transaction(fn).immediate() : fn();
  }

  protected override onPartialFailure(error: unknown): void {
    // Rare (MongoDB unreachable mid-unit): the unit's SQLite statements, if any, stay applied. Loud, for an operator.
    this.sqlite?.log?.error({ err: error }, "rows: a write unit failed in MongoDB after its SQLite part committed");
  }

  /** The document `_id` of a row (a table without a key uses the rowid in its row key). */
  private idOf(spec: TableSpec, key: string, row: Row): unknown {
    return spec.primaryKey.length ? docId(spec, row) : Number(key.slice(2));
  }

  protected async persist({ changes, counters }: PersistedChanges): Promise<void> {
    const ops = new Map<string, AnyBulkWriteOperation<Document>[]>();
    for (const { table, key, row } of changes) {
      const spec = this.specs.get(table)!;
      const list = ops.get(table) ?? [];
      if (row) {
        const withRowid = spec.primaryKey.length ? row : { ...row, rowid: Number(key.slice(2)) };
        const doc = toDocument(spec, withRowid);
        list.push({ replaceOne: { filter: { _id: doc._id as never }, replacement: doc, upsert: true } });
      } else {
        const before = this.state(table).rows.get(key);
        if (!before) continue; // inserted and deleted in the same unit
        list.push({ deleteOne: { filter: { _id: this.idOf(spec, key, before) as never } } });
      }
      ops.set(table, list);
    }
    await this.mongo.transaction(async () => {
      const session = this.mongo.session();
      for (const [table, list] of ops) if (list.length) await this.mongo.db.collection<Document>(table).bulkWrite(list, { ordered: true, session });
      for (const [table, last] of counters) {
        if (!this.specs.get(table)!.autoincrement) continue;
        await this.mongo.db
          .collection<{ _id: string; value: number }>(META_COLLECTION)
          .updateOne({ _id: counterId(table) }, { $max: { value: last } }, { upsert: true, session });
      }
    });
  }
}
