/**
 * Rows: table-shaped data a domain keeps in SQLite or, in MongoDB mode, in MongoDB with an in-memory copy for synchronous
 * reads (docs/MONGODB.md › Rows). The same small query language runs on both, with SQL's semantics:
 *
 * - `{ col: v }` is `col = v`; `{ col: null }` is `col IS NULL`.
 * - `{ col: { ne: v } }` is `col != v` (false for NULL, as in SQL); `{ ne: null }` is `col IS NOT NULL`.
 * - `{ col: { in: [...] } }`, `{ notIn: [...] }` (an empty list matches nothing / everything; NULL never matches).
 * - `{ col: { gt | gte | lt | lte: v } }`: false for NULL; [v] a number, or text compared by code units (SQLite's BINARY
 *   order, ASCII case folded in a NOCASE column), e.g. a "YYYY-MM-DD" day.
 * - Fields are ANDed; `$or: [where, …]` adds one OR group.
 * - A column declared COLLATE NOCASE compares ignoring ASCII case, in equality and in uniqueness.
 *
 * Writes happen inside `write(fn)`: [fn] runs synchronously and its changes are applied atomically, or not at all if it
 * throws. Units run one at a time. SQLite runs a unit as one IMMEDIATE transaction (other SQL inside it joins the
 * transaction); MongoDB stages the unit in memory, commits it in one MongoDB transaction, then publishes it to memory.
 */

export type Value = string | number | null;

export type Cond =
  | Value
  | { in: readonly Value[] }
  | { notIn: readonly Value[] }
  | { ne: Value }
  | { gt: number | string }
  | { gte: number | string }
  | { lt: number | string }
  | { lte: number | string };

export type Where = { [column: string]: Cond | Where[] | undefined } & { $or?: Where[] };

export interface Query {
  where?: Where;
  /** Columns and directions, in order. */
  orderBy?: readonly (readonly [string, "asc" | "desc"])[];
  limit?: number;
}

/** A row as SQLite returns it: column → value. */
export type Row = Record<string, unknown>;

export interface RowReader {
  /** The first row matching [where] (in [orderBy] order when given), or undefined. */
  get<R = Row>(table: string, where: Where, orderBy?: Query["orderBy"]): R | undefined;
  all<R = Row>(table: string, query?: Query): R[];
  count(table: string, where?: Where): number;
}

export interface InsertResult {
  /** False when [orIgnore] skipped a row that conflicts with an existing one. */
  inserted: boolean;
  /** The new row's id in an AUTOINCREMENT table. */
  id?: number;
}

export interface RowWriter extends RowReader {
  /** Inserts a row (omitted columns take their defaults). A key conflict throws, or with [orIgnore] does nothing. */
  insert(table: string, row: Row, opts?: { orIgnore?: boolean }): InsertResult;
  /**
   * Inserts [row], or when its primary key exists, sets [onConflict] on the existing row (`INSERT … ON CONFLICT(pk) DO
   * UPDATE SET`). Pass `"replace"` to replace the whole row.
   */
  upsert(table: string, row: Row, onConflict: Row | "replace"): void;
  /** Sets [set] on every matching row; returns how many. */
  update(table: string, where: Where, set: Row): number;
  /** Deletes every matching row, with the cascades its foreign keys declare; returns how many. */
  delete(table: string, where: Where): number;
}

export interface Rows extends RowReader {
  readonly backend: "sqlite" | "mongodb";
  /** One atomic unit of writes (see the module comment). Resolves with [fn]'s result once the unit is durable. */
  write<T>(fn: (w: RowWriter) => T): Promise<T>;
  /** Whether [table] is one of these rows' tables. */
  has(table: string): boolean;
  /** Resolves once every unit started so far is durable or failed (before the store's connection closes). */
  settled(): Promise<void>;
  /** Stops following other processes' writes (MongoDB), before the client closes; nothing to do for SQLite. */
  close(): Promise<void>;
}

/** A write broke a uniqueness rule: same message as SQLite's, so callers and logs read alike. */
export class ConstraintError extends Error {
  readonly code = "SQLITE_CONSTRAINT_UNIQUE";
  constructor(table: string, columns: readonly string[]) {
    super(`UNIQUE constraint failed: ${columns.map((c) => `${table}.${c}`).join(", ")}`);
  }
}
