import type { ColumnSpec, ForeignKeySpec, TableSpec } from "../mongo/catalog.js";
import { type Cond, ConstraintError, type InsertResult, type Query, type Row, type Rows, type RowWriter, type Value, type Where } from "./types.js";

/**
 * Rows held in memory with SQLite's semantics (types.ts), for a store whose durable copy is elsewhere: [persist] makes a
 * unit's changes durable before they are published here. Only one process may hold a domain this way (the server is one
 * process already: its WebSocket hub is in memory too).
 */

interface TableState {
  spec: TableSpec;
  rows: Map<string, Row>;
  /** Equality indexes on the committed rows, built on first use: column → normalised value → row keys. */
  indexes: Map<string, Map<string, Set<string>>>;
  /** The next rowid (a table without a declared key, or an AUTOINCREMENT key). */
  nextId: number;
}

/** A unit's changes: row key → the row after the unit (null: deleted). */
type Overlay = Map<string, Map<string, Row | null>>;

export interface RowChange {
  table: string;
  key: string;
  /** The row after the unit, or null when it was deleted. */
  row: Row | null;
}

export interface PersistedChanges {
  changes: RowChange[];
  /** AUTOINCREMENT tables whose counter moved: table → the last id handed out. */
  counters: Map<string, number>;
}

const foldAscii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function column(spec: TableSpec, name: string): ColumnSpec {
  const c = spec.columns.find((x) => x.name === name);
  if (!c) throw new Error(`rows: ${spec.name} has no column ${name}`);
  return c;
}

/** A value as compared in [col] (NOCASE columns ignore ASCII case). */
function norm(spec: TableSpec, col: string, v: unknown): unknown {
  return typeof v === "string" && column(spec, col).nocase ? foldAscii(v) : v;
}

/** A hashable form of a value that keeps 1 and "1" apart. */
const hashable = (v: unknown) => (v === null || v === undefined ? "n:" : `${typeof v === "number" ? "d" : "s"}:${String(v)}`);

function rowKey(spec: TableSpec, row: Row, rowid?: number): string {
  if (spec.primaryKey.length === 0) return `r:${rowid}`;
  return spec.primaryKey.map((c) => hashable(norm(spec, c, row[c]))).join("|");
}

/** SQLite's order: NULL, then numbers, then text; text by code units (NOCASE columns folded). */
function compare(spec: TableSpec, col: string, a: unknown, b: unknown): number {
  const rank = (v: unknown) => (v === null || v === undefined ? 0 : typeof v === "number" ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  const x = norm(spec, col, a) as number | string;
  const y = norm(spec, col, b) as number | string;
  return x < y ? -1 : x > y ? 1 : 0;
}

function equal(spec: TableSpec, col: string, a: unknown, b: Value): boolean {
  if (a === null || a === undefined || b === null) return false;
  return norm(spec, col, a) === norm(spec, col, b);
}

function matchCond(spec: TableSpec, col: string, v: unknown, cond: Cond): boolean {
  if (cond === null) return v === null || v === undefined;
  if (typeof cond !== "object") return equal(spec, col, v, cond);
  if ("in" in cond) return cond.in.some((x) => equal(spec, col, v, x));
  if ("notIn" in cond) {
    if (cond.notIn.length === 0) return true;
    if (v === null || v === undefined || cond.notIn.includes(null)) return false;
    return !cond.notIn.some((x) => equal(spec, col, v, x));
  }
  if ("ne" in cond) {
    if (cond.ne === null) return v !== null && v !== undefined;
    if (v === null || v === undefined) return false;
    return !equal(spec, col, v, cond.ne);
  }
  if (v === null || v === undefined) return false;
  const [op, n] = Object.entries(cond)[0] as [string, number];
  const c = compare(spec, col, v, n);
  return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
}

export function matches(spec: TableSpec, row: Row, where: Where | undefined): boolean {
  for (const [col, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue;
    if (col === "$or") {
      if (!(cond as Where[]).some((g) => matches(spec, row, g))) return false;
      continue;
    }
    column(spec, col);
    if (!matchCond(spec, col, row[col], cond as Cond)) return false;
  }
  return true;
}

/** The literal equality conditions of a where (used to pick an index). */
function equalities(where: Where | undefined): [string, Value][] {
  return Object.entries(where ?? {}).filter(
    (e): e is [string, Value] => e[0] !== "$or" && e[1] !== undefined && e[1] !== null && typeof e[1] !== "object",
  );
}

export abstract class MemoryRows implements Rows {
  abstract readonly backend: "sqlite" | "mongodb";
  protected readonly tables = new Map<string, TableState>();
  /** Child foreign keys of each table: who references it. */
  private readonly children = new Map<string, { table: string; fk: ForeignKeySpec }[]>();
  /** The unit whose function is running now (synchronously): reads see its changes, nested writes join it. */
  private active: Unit | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  protected constructor(specs: TableSpec[]) {
    for (const spec of specs) this.tables.set(spec.name, { spec, rows: new Map(), indexes: new Map(), nextId: 1 });
    for (const spec of specs) {
      for (const fk of spec.foreignKeys) {
        if (!this.tables.has(fk.table)) continue; // parents elsewhere (users): their own store's business
        this.children.set(fk.table, [...(this.children.get(fk.table) ?? []), { table: spec.name, fk }]);
      }
    }
  }

  /** Makes a unit's changes durable (MongoDB: one transaction). Throwing discards the unit. */
  protected abstract persist(changes: PersistedChanges): Promise<void>;

  has(table: string): boolean {
    return this.tables.has(table);
  }

  protected state(table: string): TableState {
    const s = this.tables.get(table);
    if (!s) throw new Error(`rows: unknown table ${table}`);
    return s;
  }

  /** Loads a committed row (startup). */
  protected load(table: string, row: Row, rowid?: number): void {
    const s = this.state(table);
    const id = rowid ?? (s.spec.autoincrement ? Number(row[s.spec.primaryKey[0]]) : undefined);
    if (id !== undefined && id >= s.nextId) s.nextId = id + 1;
    s.rows.set(rowKey(s.spec, row, rowid), row);
  }

  protected bumpCounter(table: string, last: number): void {
    const s = this.state(table);
    if (last >= s.nextId) s.nextId = last + 1;
  }

  // ───────────── reads ─────────────

  private index(s: TableState, col: string): Map<string, Set<string>> {
    let ix = s.indexes.get(col);
    if (!ix) {
      ix = new Map();
      for (const [k, r] of s.rows) {
        const h = hashable(norm(s.spec, col, r[col]));
        let set = ix.get(h);
        if (!set) ix.set(h, (set = new Set()));
        set.add(k);
      }
      s.indexes.set(col, ix);
    }
    return ix;
  }

  /** Matching [key, row] pairs, as the unit (when given) sees them. */
  protected scan(table: string, where: Where | undefined, overlay?: Overlay): [string, Row][] {
    const s = this.state(table);
    const staged = overlay?.get(table);
    const eq = equalities(where);
    let keys: Iterable<string>;
    if (s.spec.primaryKey.length && s.spec.primaryKey.every((c) => eq.some(([col]) => col === c))) {
      keys = [rowKey(s.spec, Object.fromEntries(eq))];
    } else if (eq.length) {
      const [col, v] = eq[0];
      keys = this.index(s, col).get(hashable(norm(s.spec, col, v))) ?? [];
    } else keys = s.rows.keys();
    const seen = new Set<string>();
    const out: [string, Row][] = [];
    const consider = (k: string) => {
      if (seen.has(k)) return;
      seen.add(k);
      const r = staged?.has(k) ? staged.get(k)! : (s.rows.get(k) ?? null);
      if (r && matches(s.spec, r, where)) out.push([k, r]);
    };
    for (const k of keys) consider(k);
    if (staged) for (const k of staged.keys()) consider(k);
    return out;
  }

  private select<R>(table: string, query: Query, overlay?: Overlay): R[] {
    const spec = this.state(table).spec;
    let rows = this.scan(table, query.where, overlay).map(([, r]) => r);
    if (query.orderBy?.length) {
      const order = query.orderBy;
      rows = [...rows].sort((a, b) => {
        for (const [col, dir] of order) {
          const c = compare(spec, col, a[col], b[col]);
          if (c) return dir === "desc" ? -c : c;
        }
        return 0;
      });
    }
    if (query.limit !== undefined) rows = rows.slice(0, Math.max(0, Math.floor(query.limit)));
    // Copies: a caller changing a row must not change the cache.
    return rows.map((r) => ({ ...r }) as R);
  }

  get<R = Row>(table: string, where: Where, orderBy?: Query["orderBy"]): R | undefined {
    return this.select<R>(table, { where, orderBy, limit: 1 }, this.active?.overlay)[0];
  }

  all<R = Row>(table: string, query: Query = {}): R[] {
    return this.select<R>(table, query, this.active?.overlay);
  }

  count(table: string, where?: Where): number {
    return this.scan(table, where, this.active?.overlay).length;
  }

  // ───────────── writes ─────────────

  write<T>(fn: (w: RowWriter) => T): Promise<T> {
    // Inside a running unit (a write started from its function): part of it, like a SQLite savepoint.
    if (this.active) {
      const unit = this.active;
      const saved = unit.snapshot();
      try {
        return Promise.resolve(fn(unit.writer));
      } catch (e) {
        unit.restore(saved);
        return Promise.reject(e);
      }
    }
    const run = async (): Promise<T> => {
      const unit = new Unit(this);
      this.active = unit;
      let result: T;
      try {
        result = fn(unit.writer);
      } finally {
        this.active = null;
      }
      if (result instanceof Promise) throw new Error("rows: a write unit must be synchronous");
      const changes = unit.changes();
      if (changes.changes.length) {
        await this.persist(changes);
        this.publish(unit.overlay, changes.counters);
      }
      return result;
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private publish(overlay: Overlay, counters: Map<string, number>): void {
    for (const [table, staged] of overlay) {
      const s = this.state(table);
      for (const [k, row] of staged) {
        const old = s.rows.get(k);
        for (const [col, ix] of s.indexes) {
          if (old) ix.get(hashable(norm(s.spec, col, old[col])))?.delete(k);
          if (row) {
            const h = hashable(norm(s.spec, col, row[col]));
            let set = ix.get(h);
            if (!set) ix.set(h, (set = new Set()));
            set.add(k);
          }
        }
        if (row) s.rows.set(k, row);
        else s.rows.delete(k);
      }
    }
    for (const [table, last] of counters) this.bumpCounter(table, last);
  }

  // Used by Unit.
  childrenOf(table: string) {
    return this.children.get(table) ?? [];
  }
  tableState(table: string) {
    return this.state(table);
  }
  scanFor(table: string, where: Where | undefined, overlay: Overlay) {
    return this.scan(table, where, overlay);
  }
}

/** One write unit: changes staged over the committed rows until it is persisted. */
class Unit {
  overlay: Overlay = new Map();
  /** AUTOINCREMENT ids and rowids handed out in this unit: table → next. */
  private nextIds = new Map<string, number>();
  readonly writer: RowWriter;

  constructor(private readonly rows: MemoryRows) {
    this.writer = {
      get: (t, where, orderBy) => rows.get(t, where, orderBy),
      all: (t, query) => rows.all(t, query),
      count: (t, where) => rows.count(t, where),
      insert: (t, row, opts) => this.insert(t, row, opts),
      upsert: (t, row, onConflict) => this.upsert(t, row, onConflict),
      update: (t, where, set) => this.update(t, where, set),
      delete: (t, where) => this.delete(t, where),
    };
  }

  snapshot(): { overlay: Overlay; nextIds: Map<string, number> } {
    return { overlay: new Map([...this.overlay].map(([t, m]) => [t, new Map(m)])), nextIds: new Map(this.nextIds) };
  }

  restore(s: { overlay: Overlay; nextIds: Map<string, number> }): void {
    this.overlay = s.overlay;
    this.nextIds = s.nextIds;
  }

  changes(): PersistedChanges {
    const changes: RowChange[] = [];
    for (const [table, staged] of this.overlay) for (const [key, row] of staged) changes.push({ table, key, row });
    const counters = new Map<string, number>();
    for (const [table, next] of this.nextIds) counters.set(table, next - 1);
    return { changes, counters };
  }

  private stage(table: string, key: string, row: Row | null): void {
    let m = this.overlay.get(table);
    if (!m) this.overlay.set(table, (m = new Map()));
    m.set(key, row);
  }

  private current(table: string, key: string): Row | null {
    const staged = this.overlay.get(table);
    if (staged?.has(key)) return staged.get(key)!;
    return this.rows.tableState(table).rows.get(key) ?? null;
  }

  private takeId(table: string): number {
    const s = this.rows.tableState(table);
    const next = Math.max(this.nextIds.get(table) ?? 0, s.nextId);
    this.nextIds.set(table, next + 1);
    return next;
  }

  /** The row as stored: every column, defaults for the ones not given, NOT NULL enforced. */
  private complete(spec: TableSpec, row: Row): Row {
    for (const k of Object.keys(row)) if (row[k] !== undefined) column(spec, k);
    const full: Row = {};
    for (const c of spec.columns) {
      let v = row[c.name];
      if (v === undefined) {
        const d = c.default;
        if (d !== undefined && d !== null && typeof d === "object") throw new Error(`rows: ${spec.name}.${c.name} has an expression default`);
        v = d ?? null;
      }
      full[c.name] = v;
    }
    return full;
  }

  private checkNotNull(spec: TableSpec, row: Row): void {
    for (const c of spec.columns) if (c.notNull && (row[c.name] === null || row[c.name] === undefined)) throw new Error(`NOT NULL constraint failed: ${spec.name}.${c.name}`);
  }

  /** Throws if another row (not [selfKey]) holds one of [row]'s unique values; with [ignore], reports it instead. */
  private uniqueConflict(spec: TableSpec, row: Row, selfKey: string | null): string[] | null {
    for (const ix of spec.indexes) {
      if (!ix.unique) continue;
      if (ix.partialNotNull?.some((c) => row[c] === null || row[c] === undefined)) continue;
      if (ix.columns.some((c) => row[c] === null || row[c] === undefined)) continue; // NULLs never conflict
      const where = Object.fromEntries(ix.columns.map((c) => [c, row[c] as Value]));
      if (this.rows.scanFor(spec.name, where, this.overlay).some(([k]) => k !== selfKey)) return ix.columns;
    }
    return null;
  }

  private checkParents(spec: TableSpec, row: Row): void {
    for (const fk of spec.foreignKeys) {
      if (!this.rows.has(fk.table)) continue;
      if (fk.columns.some((c) => row[c] === null || row[c] === undefined)) continue;
      const where = Object.fromEntries(fk.references.map((r, i) => [r, row[fk.columns[i]] as Value]));
      if (this.rows.scanFor(fk.table, where, this.overlay).length === 0) throw new Error("FOREIGN KEY constraint failed");
    }
  }

  insert(table: string, given: Row, opts: { orIgnore?: boolean } = {}): InsertResult {
    const spec = this.rows.tableState(table).spec;
    const row = this.complete(spec, given);
    let id: number | undefined;
    let rowid: number | undefined;
    if (spec.autoincrement && (row[spec.primaryKey[0]] === null || row[spec.primaryKey[0]] === undefined)) row[spec.primaryKey[0]] = id = this.takeId(table);
    if (spec.primaryKey.length === 0) rowid = this.takeId(table);
    const key = rowKey(spec, row, rowid);
    if (this.current(table, key)) {
      if (opts.orIgnore) return { inserted: false };
      throw new ConstraintError(table, spec.primaryKey);
    }
    const unique = this.uniqueConflict(spec, row, null);
    if (unique) {
      if (opts.orIgnore) return { inserted: false };
      throw new ConstraintError(table, unique);
    }
    this.checkNotNull(spec, row);
    this.checkParents(spec, row);
    this.stage(table, key, row);
    return { inserted: true, ...(id !== undefined ? { id } : {}) };
  }

  upsert(table: string, given: Row, onConflict: Row | "replace"): void {
    const spec = this.rows.tableState(table).spec;
    if (spec.primaryKey.length === 0) throw new Error(`rows: ${table} has no key to upsert on`);
    const key = rowKey(spec, given);
    const existing = this.current(table, key);
    if (!existing) {
      this.insert(table, given);
      return;
    }
    const set =
      onConflict === "replace" ? Object.fromEntries(Object.entries(given).filter(([k, v]) => v !== undefined && !spec.primaryKey.includes(k))) : onConflict;
    this.change(spec, key, existing, set);
  }

  /** Sets [set] on one row (its key may change), checking constraints. */
  private change(spec: TableSpec, key: string, existing: Row, set: Row): void {
    for (const k of Object.keys(set)) if (set[k] !== undefined) column(spec, k);
    const row: Row = { ...existing };
    for (const [k, v] of Object.entries(set)) if (v !== undefined) row[k] = v;
    this.checkNotNull(spec, row);
    const newKey = spec.primaryKey.length ? rowKey(spec, row) : key;
    if (newKey !== key && this.current(spec.name, newKey)) throw new ConstraintError(spec.name, spec.primaryKey);
    const unique = this.uniqueConflict(spec, row, key);
    if (unique) throw new ConstraintError(spec.name, unique);
    this.checkParents(spec, row);
    if (newKey !== key) this.stage(spec.name, key, null);
    this.stage(spec.name, newKey, row);
  }

  update(table: string, where: Where, set: Row): number {
    const spec = this.rows.tableState(table).spec;
    const hits = this.rows.scanFor(table, where, this.overlay);
    for (const [key, row] of hits) this.change(spec, key, row, set);
    return hits.length;
  }

  delete(table: string, where: Where): number {
    const hits = this.rows.scanFor(table, where, this.overlay);
    for (const [key, row] of hits) this.remove(table, key, row);
    return hits.length;
  }

  /** Deletes one row and applies its children's ON DELETE rules (SQLite with foreign_keys = ON). */
  private remove(table: string, key: string, row: Row): void {
    if (!this.current(table, key)) return; // already gone through another cascade
    this.stage(table, key, null);
    for (const { table: child, fk } of this.rows.childrenOf(table)) {
      if (fk.references.some((r) => row[r] === null || row[r] === undefined)) continue;
      const where = Object.fromEntries(fk.columns.map((c, i) => [c, row[fk.references[i]] as Value]));
      const kids = this.rows.scanFor(child, where, this.overlay);
      if (kids.length === 0) continue;
      if (fk.onDelete === "CASCADE") for (const [k, r] of kids) this.remove(child, k, r);
      else if (fk.onDelete === "SET NULL") {
        const childSpec = this.rows.tableState(child).spec;
        for (const [k, r] of kids) this.change(childSpec, k, r, Object.fromEntries(fk.columns.map((c) => [c, null])));
      } else throw new Error("FOREIGN KEY constraint failed");
    }
  }
}
