import type { Collection, Document, Filter, IndexSpecification } from "mongodb";
import { isDuplicateKey, type MeldiqMongo } from "./mongo/client.js";

/**
 * A small keyed document store for new, self-contained data (API 0.65.0 batch B: creator applications, linked
 * accounts): MongoDB whenever the server has one, otherwise this process's memory (development and tests without
 * MONGODB_URI). Every write touches one document. Queries are equality on top-level fields only, which is all these
 * features need. In MongoDB the fields are stored in snake_case beside `_id` (docs/MONGODB.md §3); times stay epoch ms.
 */
export interface Keyed {
  id: string;
}

/** Equality on top-level fields. */
export type Match<T> = Partial<{ [K in keyof T]: T[K] }>;

export interface FindOptions<T> {
  /** Newest first by this numeric field. */
  newestBy?: keyof T & string;
  /** Only documents whose [newestBy] is below this (paging). */
  before?: number;
  limit?: number;
}

/** A write refused because a document with that id, or a unique index's key, exists already. */
export class DuplicateDocument extends Error {}

export interface DocumentStore<T extends Keyed> {
  readonly backend: "memory" | "mongodb";
  /** Adds [doc]; throws DuplicateDocument when its id (or a unique index's key) is taken. */
  insert(doc: T): Promise<void>;
  /** Adds or replaces [doc] by its id. */
  put(doc: T): Promise<void>;
  get(id: string): Promise<T | null>;
  find(match: Match<T>, opts?: FindOptions<T>): Promise<T[]>;
  count(match: Match<T>): Promise<number>;
  /** Applies [change] to [id] if it still matches [where]; the document after, or null when nothing matched. */
  update(id: string, where: Match<T>, change: Partial<T>): Promise<T | null>;
  /** Removes [id] if it still matches [where]; whether it did. */
  take(id: string, where?: Match<T>): Promise<T | null>;
  deleteMany(match: Match<T>): Promise<number>;
  /** Removes every document whose numeric [field] is below [value] (expired sign-in states). */
  deleteBelow(field: keyof T & string, value: number): Promise<number>;
}

const matches = <T extends Keyed>(doc: T, match: Match<T>): boolean => Object.entries(match).every(([k, v]) => (doc as Record<string, unknown>)[k] === v);
const copy = <T>(v: T): T => structuredClone(v);

export class MemoryDocuments<T extends Keyed> implements DocumentStore<T> {
  readonly backend = "memory" as const;
  private readonly docs = new Map<string, T>();

  async insert(doc: T): Promise<void> {
    if (this.docs.has(doc.id)) throw new DuplicateDocument(doc.id);
    this.docs.set(doc.id, copy(doc));
  }

  async put(doc: T): Promise<void> {
    this.docs.set(doc.id, copy(doc));
  }

  async get(id: string): Promise<T | null> {
    const d = this.docs.get(id);
    return d ? copy(d) : null;
  }

  async find(match: Match<T>, opts: FindOptions<T> = {}): Promise<T[]> {
    const field = opts.newestBy;
    let all = [...this.docs.values()].filter((d) => matches(d, match));
    if (field) {
      const at = (d: T) => Number((d as Record<string, unknown>)[field]);
      all = all.filter((d) => opts.before === undefined || at(d) < opts.before).sort((a, b) => at(b) - at(a));
    }
    return all.slice(0, opts.limit ?? all.length).map(copy);
  }

  async count(match: Match<T>): Promise<number> {
    return [...this.docs.values()].filter((d) => matches(d, match)).length;
  }

  async update(id: string, where: Match<T>, change: Partial<T>): Promise<T | null> {
    const d = this.docs.get(id);
    if (!d || !matches(d, where)) return null;
    const next = { ...d, ...copy(change), id: d.id };
    this.docs.set(id, next);
    return copy(next);
  }

  async take(id: string, where: Match<T> = {}): Promise<T | null> {
    const d = this.docs.get(id);
    if (!d || !matches(d, where)) return null;
    this.docs.delete(id);
    return d;
  }

  async deleteMany(match: Match<T>): Promise<number> {
    let n = 0;
    for (const [id, d] of this.docs) {
      if (matches(d, match)) {
        this.docs.delete(id);
        n++;
      }
    }
    return n;
  }

  async deleteBelow(field: keyof T & string, value: number): Promise<number> {
    let n = 0;
    for (const [id, d] of this.docs) {
      if (Number((d as Record<string, unknown>)[field]) < value) {
        this.docs.delete(id);
        n++;
      }
    }
    return n;
  }
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function toDoc<T extends Keyed>(v: Partial<T>): Document {
  const out: Document = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    out[k === "id" ? "_id" : snake(k)] = x;
  }
  return out;
}

function fromDoc<T extends Keyed>(d: Document): T {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(d)) out[k === "_id" ? "id" : camel(k)] = x;
  return out as T;
}

/** One index on snake_case fields; [partial] limits it (a unique index that applies only while `status` is "pending"). */
export interface DocumentIndex {
  name: string;
  keys: IndexSpecification & Record<string, 1 | -1>;
  unique?: boolean;
  partial?: Document;
}

export class MongoDocuments<T extends Keyed> implements DocumentStore<T> {
  readonly backend = "mongodb" as const;
  private readonly col: Collection<Document>;

  constructor(
    mongo: MeldiqMongo,
    collection: string,
    private readonly indexes: readonly DocumentIndex[] = [],
  ) {
    this.col = mongo.db.collection(collection);
  }

  /** The indexes the feature named (idempotent). */
  async ensureIndexes(): Promise<void> {
    for (const i of this.indexes) {
      await this.col.createIndex(i.keys, { name: i.name, ...(i.unique ? { unique: true } : {}), ...(i.partial ? { partialFilterExpression: i.partial } : {}) });
    }
  }

  async insert(doc: T): Promise<void> {
    try {
      await this.col.insertOne(toDoc(doc));
    } catch (e) {
      if (isDuplicateKey(e)) throw new DuplicateDocument(doc.id);
      throw e;
    }
  }

  async put(doc: T): Promise<void> {
    const { _id, ...rest } = toDoc(doc);
    await this.col.replaceOne({ _id } as unknown as Filter<Document>, rest, { upsert: true });
  }

  async get(id: string): Promise<T | null> {
    const d = await this.col.findOne({ _id: id } as unknown as Filter<Document>);
    return d ? fromDoc<T>(d) : null;
  }

  async find(match: Match<T>, opts: FindOptions<T> = {}): Promise<T[]> {
    const filter = toDoc(match);
    const field = opts.newestBy ? snake(opts.newestBy) : null;
    if (field && opts.before !== undefined) filter[field] = { $lt: opts.before };
    let cursor = this.col.find(filter);
    if (field) cursor = cursor.sort({ [field]: -1 });
    if (opts.limit !== undefined) cursor = cursor.limit(opts.limit);
    return (await cursor.toArray()).map((d) => fromDoc<T>(d));
  }

  async count(match: Match<T>): Promise<number> {
    return this.col.countDocuments(toDoc(match));
  }

  async update(id: string, where: Match<T>, change: Partial<T>): Promise<T | null> {
    const { _id: _ignored, ...set } = toDoc(change);
    const d = await this.col.findOneAndUpdate({ ...toDoc(where), _id: id } as unknown as Filter<Document>, { $set: set }, { returnDocument: "after" });
    return d ? fromDoc<T>(d) : null;
  }

  async take(id: string, where: Match<T> = {}): Promise<T | null> {
    const d = await this.col.findOneAndDelete({ ...toDoc(where), _id: id } as unknown as Filter<Document>);
    return d ? fromDoc<T>(d) : null;
  }

  async deleteMany(match: Match<T>): Promise<number> {
    return (await this.col.deleteMany(toDoc(match))).deletedCount;
  }

  async deleteBelow(field: keyof T & string, value: number): Promise<number> {
    return (await this.col.deleteMany({ [snake(field)]: { $lt: value } })).deletedCount;
  }
}

/** The store a feature uses: MongoDB whenever the server has one, memory otherwise. Indexes are made before first use. */
export async function openDocuments<T extends Keyed>(mongo: MeldiqMongo | null | undefined, collection: string, indexes: readonly DocumentIndex[] = []): Promise<DocumentStore<T>> {
  if (!mongo) return new MemoryDocuments<T>();
  const store = new MongoDocuments<T>(mongo, collection, indexes);
  await store.ensureIndexes();
  return store;
}
