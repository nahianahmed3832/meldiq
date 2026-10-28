import type { DB } from "./db.js";

/** SQLite's limit on bound parameters is generous, but a long list is still sent in pieces. */
const CHUNK = 500;

/**
 * Rows of a SQLite [table] whose [column] is one of [ids] (in no particular order), for joining with rows another store
 * holds: `SELECT [columns] FROM table WHERE column IN (…)`, chunked.
 */
export function rowsByIds<T>(db: DB, table: string, column: string, ids: Iterable<string>, columns = "*"): T[] {
  const list = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    out.push(...(db.prepare(`SELECT ${columns} FROM "${table}" WHERE "${column}" IN (${part.map(() => "?").join(", ")})`).all(...part) as T[]));
  }
  return out;
}

/** The same rows keyed by [key]. */
export function mapByIds<T extends Record<string, unknown>>(db: DB, table: string, column: string, ids: Iterable<string>, columns = "*", key = column): Map<string, T> {
  return new Map(rowsByIds<T>(db, table, column, ids, columns).map((r) => [String(r[key]), r]));
}
