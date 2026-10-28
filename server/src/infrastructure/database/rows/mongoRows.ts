import { type AnyBulkWriteOperation, BSON, type ChangeStream, type ChangeStreamDocument, type Document, type Timestamp } from "mongodb";
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
 *
 * Writes another process makes (the operator CLI: `admin disable`, `reg-invite`, a console grant) reach memory through
 * a change stream on these collections: each changed document is read again and its current state applied in the
 * write queue, between this process's units, so memory never goes back to an older version. This process's own
 * transactions are recognised by their session and skipped (their changes are already in memory).
 */
export class MongoRows extends MemoryRows {
  readonly backend = "mongodb" as const;
  private readonly specs: Map<string, TableSpec>;
  private stream: ChangeStream | null = null;
  private closed = false;
  /** Sessions of this process's own write units (their change events are skipped). */
  private readonly ownSessions = new Set<string>();
  /** Documents changed elsewhere, waiting to be read again: collection → their ids (keyed by EJSON text). */
  private pending = new Map<string, Map<string, unknown>>();
  private draining = false;

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
    // Following starts before the load, so nothing committed in between is missed; the load runs in the write queue, so
    // a change read again meanwhile is applied after it, never overwritten by it.
    await rows.follow();
    await rows.between(() => rows.loadAll());
    return rows;
  }

  /** Stops following other processes' writes (before the MongoDB client closes). */
  async close(): Promise<void> {
    this.closed = true;
    await this.stream?.close().catch(() => undefined);
  }

  private async follow(): Promise<void> {
    if (!this.mongo.supportsTransactions) return; // no change streams without a replica set (development only)
    // The stream starts at a cluster time read now, before the load: nothing committed after it is missed, without
    // waiting for the stream's first answer. A change it repeats is harmless (each document is read again).
    const session = this.mongo.client.startSession();
    let startAtOperationTime: Timestamp | undefined;
    try {
      await this.mongo.db.collection(META_COLLECTION).findOne({}, { session });
      startAtOperationTime = session.operationTime;
    } finally {
      await session.endSession();
    }
    // Collections by name: Atlas's shared tiers take $in on collection names (not on database names).
    const stream = this.mongo.db.watch([{ $match: { "ns.coll": { $in: [...this.specs.keys(), META_COLLECTION] } } }], startAtOperationTime ? { startAtOperationTime } : {});
    this.stream = stream;
    void this.listen(stream);
  }

  private async listen(stream: ChangeStream): Promise<void> {
    try {
      for await (const change of stream) this.note(change);
    } catch (e) {
      // The driver resumes after transient errors by itself; this one isn't (or the client is closing).
      if (this.closed || /clos/i.test((e as Error).message)) return;
      this.sqlite?.log?.error({ err: e }, "rows: following other processes' writes stopped; reloading");
      await this.stream?.close().catch(() => undefined);
      try {
        await this.follow();
        await this.resync();
      } catch (err) {
        this.sqlite?.log?.error({ err }, "rows: couldn't follow other processes' writes again");
      }
    }
  }

  private note(change: ChangeStreamDocument): void {
    if (!("ns" in change) || !change.ns || !("coll" in change.ns)) {
      // A dropped or renamed collection: read everything again.
      void this.resync().catch((err) => this.sqlite?.log?.error({ err }, "rows: reload after a dropped collection failed"));
      return;
    }
    const lsid = (change as { lsid?: { id?: { toString(enc: string): string } } }).lsid?.id;
    if (lsid && this.ownSessions.has(lsid.toString("hex"))) return;
    if (!("documentKey" in change)) return;
    const coll = change.ns.coll;
    const id = (change.documentKey as { _id: unknown })._id;
    if (coll === META_COLLECTION && !(typeof id === "string" && id.startsWith("seq:") && this.specs.has(id.slice(4)))) return;
    const ids = this.pending.get(coll) ?? new Map<string, unknown>();
    ids.set(BSON.EJSON.stringify(id as never), id);
    this.pending.set(coll, ids);
    this.drain();
  }

  /** Reads the documents changed elsewhere again and applies what they are now, in the write queue. */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.between(async () => {
      this.draining = false;
      const batch = this.pending;
      this.pending = new Map();
      for (const [coll, ids] of batch) {
        const docs = await this.mongo.db.collection<Document>(coll).find({ _id: { $in: [...ids.values()] as never[] } }).toArray();
        if (coll === META_COLLECTION) {
          for (const d of docs) this.bumpCounter(String(d._id).slice(4), Number(d.value));
          continue;
        }
        const spec = this.specs.get(coll)!;
        const found = new Map(docs.map((d) => [BSON.EJSON.stringify(d._id as never), d]));
        for (const [text, id] of ids) {
          const doc = found.get(text);
          // Another process's rowid is never handed out here again.
          if (doc && spec.primaryKey.length === 0) this.bumpCounter(coll, Number(id));
          this.applyExternal(coll, doc ? this.rowOf(spec, doc) : null, this.keyOfId(spec, id));
        }
      }
    }).catch((err) => this.sqlite?.log?.error({ err }, "rows: applying another process's writes failed"));
  }

  /** Every collection read again and memory brought to it, in the write queue (after following had to restart). */
  private resync(): Promise<void> {
    return this.between(async () => {
      for (const spec of this.specs.values()) {
        const docs = await this.mongo.db.collection<Document>(spec.name).find({}).toArray();
        const now = new Map(docs.map((d) => [this.keyOfId(spec, d._id), d]));
        for (const key of this.state(spec.name).rows.keys()) if (!now.has(key)) this.applyExternal(spec.name, null, key);
        for (const [key, d] of now) this.applyExternal(spec.name, this.rowOf(spec, d), key);
      }
    });
  }

  /** A document as a committed row (a rowid table's row doesn't carry its rowid). */
  private rowOf(spec: TableSpec, doc: Document): Row {
    const row = toRow(spec, doc as Record<string, unknown>);
    if (spec.primaryKey.length === 0) delete row.rowid;
    return row;
  }

  /** The row key of the document with this `_id`. */
  private keyOfId(spec: TableSpec, id: unknown): string {
    if (spec.primaryKey.length === 0) return this.keyOf(spec.name, {}, Number(id));
    if (spec.primaryKey.length === 1) return this.keyOf(spec.name, { [spec.primaryKey[0]]: id });
    return this.keyOf(spec.name, id as Row);
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
      const lsid = session?.id?.id;
      if (lsid) this.ownSessions.add(lsid.toString("hex"));
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
