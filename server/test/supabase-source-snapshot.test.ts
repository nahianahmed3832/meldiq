import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { tableSpecs, toDocument } from "../src/infrastructure/database/mongo/catalog.js";
import { NATIVE_TABLES } from "../src/infrastructure/database/postgres/nativeCatalog.js";
import { exactBson, normalizeSourceDocument } from "../src/infrastructure/database/postgres/sourceSnapshot.js";

describe("real-data snapshot normalization", () => {
  it("retains safe 64-bit values and binary contents without rounding", () => {
    expect(exactBson({at: BSON.Long.fromString("1793629123456"), data: new BSON.Binary(Buffer.from([0, 255]))})).toEqual({at: 1793629123456, data: Buffer.from([0, 255])});
    expect(() => exactBson(BSON.Long.fromString("9007199254740993"))).toThrow("unsafe_integer");
  });
  it("preserves original composite IDs and refuses ID substitution", () => {
    const spec = tableSpecs().find(table => table.primaryKey.length > 1)!;
    const row = Object.fromEntries(spec.columns.map(column => [column.name, column.type === "INTEGER" ? 42 : "original"]));
    const doc = toDocument(spec, row);
    expect(normalizeSourceDocument(spec, BSON.EJSON.stringify(doc))).toEqual(row);
    expect(() => normalizeSourceDocument(spec, BSON.EJSON.stringify({...doc, _id: "changed"}))).toThrow("source_id_mismatch");
  });
  it("refuses silent loss of new source fields", () => {
    const spec = tableSpecs()[0];
    expect(() => normalizeSourceDocument(spec, BSON.EJSON.stringify({_id: "old", new_secret: "must not disappear"}))).toThrow("unmapped_source_field");
  });
  it("uses native IDs and only fills absent nullable fields", () => {
    const spec = NATIVE_TABLES.find(table => table.name === "creator_program")!;
    const row = normalizeSourceDocument(spec, BSON.EJSON.stringify({_id: "original", user_id: "owner", status: "pending", created_at: new BSON.Long(123)}));
    expect(row).toEqual({id: "original", user_id: "owner", status: "pending", created_at: 123, reason: null, reviewed_by: null, reviewed_at: null});
    expect(() => normalizeSourceDocument(spec, BSON.EJSON.stringify({_id: "original", id: "forged"}))).toThrow("native_id_mismatch");
  });
});
