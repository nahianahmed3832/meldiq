import type { Row, RowReader } from "./rows/index.js";

/**
 * Rows of [table] (in [rows], another domain's store) whose [column] is one of [ids], in no particular order, for joining
 * with rows a domain holds: `SELECT [columns] FROM table WHERE column IN (…)`. [columns] ("id, username") keeps only
 * those fields; "*" keeps the whole row.
 */
export function rowsByIds<T>(rows: RowReader, table: string, column: string, ids: Iterable<string>, columns = "*"): T[] {
  const list = [...new Set(ids)];
  if (list.length === 0) return [];
  const found = rows.all<Row>(table, { where: { [column]: { in: list } } });
  if (columns.trim() === "*") return found as T[];
  const keep = columns.split(",").map((c) => c.trim());
  return found.map((r) => Object.fromEntries(keep.map((c) => [c, r[c]])) as T);
}

/** The same rows keyed by [key]. */
export function mapByIds<T extends Record<string, unknown>>(rows: RowReader, table: string, column: string, ids: Iterable<string>, columns = "*", key = column): Map<string, T> {
  return new Map(rowsByIds<T>(rows, table, column, ids, columns).map((r) => [String(r[key]), r]));
}
