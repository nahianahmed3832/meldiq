import type { DB } from "../db.js";
import type { TableSpec } from "../mongo/catalog.js";
import type { Cond, InsertResult, Query, Row, RowReader, Rows, RowWriter, Where } from "./types.js";

const q = (name: string) => `"${name}"`;

/** SQL for a where (types.ts semantics; SQLite applies each column's own collation). */
export function whereSql(spec: TableSpec, where: Where | undefined): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [col, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue;
    if (col === "$or") {
      const groups = cond as Where[];
      if (groups.length === 0) {
        parts.push("0");
        continue;
      }
      const sqls = groups.map((g) => whereSql(spec, g));
      parts.push(`(${sqls.map((g) => `(${g.sql})`).join(" OR ")})`);
      for (const g of sqls) params.push(...g.params);
      continue;
    }
    if (!spec.columns.some((c) => c.name === col)) throw new Error(`rows: ${spec.name} has no column ${col}`);
    const c = q(col);
    const v = cond as Cond;
    if (v === null) parts.push(`${c} IS NULL`);
    else if (typeof v !== "object") {
      parts.push(`${c} = ?`);
      params.push(v);
    } else if ("in" in v) {
      if (v.in.length === 0) parts.push("0");
      else {
        parts.push(`${c} IN (${v.in.map(() => "?").join(", ")})`);
        params.push(...v.in);
      }
    } else if ("notIn" in v) {
      if (v.notIn.length === 0) parts.push(`${c} IS NOT NULL OR ${c} IS NULL`);
      else {
        parts.push(`${c} NOT IN (${v.notIn.map(() => "?").join(", ")})`);
        params.push(...v.notIn);
      }
    } else if ("ne" in v) {
      if (v.ne === null) parts.push(`${c} IS NOT NULL`);
      else {
        parts.push(`${c} != ?`);
        params.push(v.ne);
      }
    } else {
      const [op, n] = Object.entries(v)[0] as [string, number];
      parts.push(`${c} ${{ gt: ">", gte: ">=", lt: "<", lte: "<=" }[op]} ?`);
      params.push(n);
    }
  }
  return { sql: parts.length ? parts.map((p) => `(${p})`).join(" AND ") : "1", params };
}

/** Rows kept in SQLite: every call is SQL on the server's database. */
export class SqliteRows implements Rows {
  readonly backend = "sqlite" as const;
  private readonly specs: Map<string, TableSpec>;
  private readonly writer: RowWriter;

  constructor(
    private readonly db: DB,
    specs: TableSpec[],
  ) {
    this.specs = new Map(specs.map((s) => [s.name, s]));
    const reader: RowReader = this;
    this.writer = {
      get: reader.get.bind(this),
      all: reader.all.bind(this),
      count: reader.count.bind(this),
      insert: (t, row, opts) => this.insert(t, row, opts),
      upsert: (t, row, onConflict) => this.upsert(t, row, onConflict),
      update: (t, where, set) => this.update(t, where, set),
      delete: (t, where) => this.delete(t, where),
    };
  }

  has(table: string): boolean {
    return this.specs.has(table);
  }

  private spec(table: string): TableSpec {
    const s = this.specs.get(table);
    if (!s) throw new Error(`rows: unknown table ${table}`);
    return s;
  }

  private select(table: string, query: Query, columns = "*"): { sql: string; params: unknown[] } {
    const spec = this.spec(table);
    const w = whereSql(spec, query.where);
    const order = query.orderBy?.length ? ` ORDER BY ${query.orderBy.map(([c, d]) => `${q(c)} ${d === "desc" ? "DESC" : "ASC"}`).join(", ")}` : "";
    const limit = query.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(query.limit))}` : "";
    return { sql: `SELECT ${columns} FROM ${q(table)} WHERE ${w.sql}${order}${limit}`, params: w.params };
  }

  get<R = Row>(table: string, where: Where, orderBy?: Query["orderBy"]): R | undefined {
    const s = this.select(table, { where, orderBy, limit: 1 });
    return this.db.prepare(s.sql).get(...s.params) as R | undefined;
  }

  all<R = Row>(table: string, query: Query = {}): R[] {
    const s = this.select(table, query);
    return this.db.prepare(s.sql).all(...s.params) as R[];
  }

  count(table: string, where?: Where): number {
    const s = this.select(table, { where }, "COUNT(*) n");
    return (this.db.prepare(s.sql).get(...s.params) as { n: number }).n;
  }

  /** SQLite units are durable when write returns. */
  settled(): Promise<void> {
    return Promise.resolve();
  }

  write<T>(fn: (w: RowWriter) => T): Promise<T> {
    try {
      return Promise.resolve(this.db.transaction(() => fn(this.writer)).immediate());
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private columns(spec: TableSpec, row: Row): string[] {
    const cols = Object.keys(row).filter((k) => row[k] !== undefined);
    for (const c of cols) if (!spec.columns.some((x) => x.name === c)) throw new Error(`rows: ${spec.name} has no column ${c}`);
    return cols;
  }

  private insert(table: string, row: Row, opts: { orIgnore?: boolean } = {}): InsertResult {
    const spec = this.spec(table);
    const cols = this.columns(spec, row);
    const sql = `INSERT${opts.orIgnore ? " OR IGNORE" : ""} INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    const r = this.db.prepare(sql).run(...cols.map((c) => row[c]));
    return { inserted: r.changes > 0, ...(spec.autoincrement && r.changes > 0 ? { id: Number(r.lastInsertRowid) } : {}) };
  }

  private upsert(table: string, row: Row, onConflict: Row | "replace"): void {
    const spec = this.spec(table);
    const cols = this.columns(spec, row);
    const set =
      onConflict === "replace"
        ? cols.filter((c) => !spec.primaryKey.includes(c)).map((c) => [`${q(c)} = excluded.${q(c)}`, [] as unknown[]] as const)
        : this.columns(spec, onConflict).map((c) => [`${q(c)} = ?`, [onConflict[c]]] as const);
    const target = spec.primaryKey.map(q).join(", ");
    const action = set.length ? `DO UPDATE SET ${set.map((s) => s[0]).join(", ")}` : "DO NOTHING";
    const sql = `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(${target}) ${action}`;
    this.db.prepare(sql).run(...cols.map((c) => row[c]), ...set.flatMap((s) => s[1]));
  }

  private update(table: string, where: Where, set: Row): number {
    const spec = this.spec(table);
    const cols = this.columns(spec, set);
    if (cols.length === 0) return 0;
    const w = whereSql(spec, where);
    const sql = `UPDATE ${q(table)} SET ${cols.map((c) => `${q(c)} = ?`).join(", ")} WHERE ${w.sql}`;
    return this.db.prepare(sql).run(...cols.map((c) => set[c]), ...w.params).changes;
  }

  private delete(table: string, where: Where): number {
    const spec = this.spec(table);
    const w = whereSql(spec, where);
    return this.db.prepare(`DELETE FROM ${q(table)} WHERE ${w.sql}`).run(...w.params).changes;
  }
}
