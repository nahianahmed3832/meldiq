import { BSON } from "mongodb";
import { docId, toRow, type TableSpec } from "../mongo/catalog.js";
import { NATIVE_TABLES, normalizeNativeDocument } from "./nativeCatalog.js";
import { rowHash, validateRow } from "./migration.js";
import type { MeldiqPostgres } from "./client.js";

/** Rehearsal customer data must not become a fixture database for older smoke/import helpers. */
export async function assertSyntheticStagingDatabase(db: MeldiqPostgres): Promise<void> {
  const state=(await db.query(`SELECT coalesce(obj_description('meldiq'::regnamespace,'pg_namespace'),'') AS purpose,
    EXISTS(SELECT 1 FROM meldiq.accounts WHERE email !~* '^[^[:space:]@]+@example[.](test|invalid)$') AS real_accounts`)).rows[0];
  if(state.real_accounts||state.purpose.startsWith("Meldiq customer-data rehearsal:"))throw new Error("Customer-data rehearsal is protected from synthetic fixture operations");
}

/** Decode BSON without rounding 64-bit counters, money or timestamps into JavaScript numbers. */
export function exactBson(value: unknown): unknown {
  if (value instanceof BSON.Long) {
    const integer = value.toBigInt();
    if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("unsafe_integer");
    return Number(integer);
  }
  if (value instanceof BSON.Int32 || value instanceof BSON.Double) return value.valueOf();
  if (value instanceof BSON.Binary) return Buffer.from(value.buffer);
  if (Array.isArray(value)) return value.map(exactBson);
  if (value && typeof value === "object") {
    if ("_bsontype" in value || value instanceof Date) throw new Error("unmapped_bson_type");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exactBson(item)]));
  }
  return value;
}

export function normalizeSourceDocument(spec: TableSpec, ejson: string): Record<string, unknown> {
  const doc = exactBson(BSON.EJSON.parse(ejson, {relaxed: false})) as Record<string, unknown>;
  if (!doc || Array.isArray(doc) || typeof doc !== "object") throw new Error("invalid_document");
  const native = NATIVE_TABLES.some(table => table.name === spec.name);
  const permitted = new Set(["_id", ...spec.columns.map(column => column.name)]);
  // This is a derived, optional Mongo query index. Canonical message payload/IDs/timestamps remain unchanged.
  if (spec.name === "message_events") permitted.add("_retrieval");
  if (Object.keys(doc).some(key => !permitted.has(key))) throw new Error("unmapped_source_field");
  if (native && doc.id !== undefined && doc.id !== doc._id) throw new Error("native_id_mismatch");
  const row = native ? normalizeNativeDocument(spec.name, doc) : toRow(spec, doc);
  for (const column of spec.columns) if (row[column.name] === undefined && !column.notNull) row[column.name] = null;
  const result = validateRow(spec, row);
  if (rowHash({id: native ? result.id : docId(spec, result)}) !== rowHash({id: doc._id})) throw new Error("source_id_mismatch");
  return result;
}
