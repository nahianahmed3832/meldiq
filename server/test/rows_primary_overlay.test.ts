import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { describeTables, type TableSpec } from "../src/infrastructure/database/mongo/catalog.js";
import { MemoryRows } from "../src/infrastructure/database/rows/memory.js";
import { SqliteRows } from "../src/infrastructure/database/rows/sqliteRows.js";

class EphemeralRows extends MemoryRows {
  readonly backend = "postgres" as const;
  constructor(specs: TableSpec[]) { super(specs); }
  protected async persist(): Promise<void> {}
}

describe.each(["sqlite", "memory"] as const)("complete primary-key overlay on %s", (backend) => {
  it("preserves staged insertion, replacement, key moves, deletion, filters and rollback", async () => {
    const db = openDatabase(":memory:");
    const specs = describeTables(db).filter((s) => s.name === "traffic_user_daily");
    const rows = backend === "sqlite" ? new SqliteRows(db, specs) : new EphemeralRows(specs);
    const table = "traffic_user_daily";
    const key = { day: "2026-11-05", user_id: "u1", metric: "messages" };
    try {
      await rows.write((w) => w.insert(table, { ...key, value: 1 }));
      await rows.write((w) => {
        w.update(table, key, { value: 2 });
        w.insert(table, { ...key, user_id: "u2", value: 20 });
        expect(rows.get(table, key)).toMatchObject({ value: 2 });
        expect(rows.get(table, { ...key, value: 20 })).toBeUndefined();
        expect(rows.get(table, { ...key, $or: [{ value: 2 }, { value: 3 }] })).toMatchObject({ value: 2 });
        expect(rows.get(table, { ...key, $or: [{ value: 20 }] })).toBeUndefined();
        w.update(table, key, { user_id: "u3" });
        expect(rows.get(table, key)).toBeUndefined();
        expect(rows.get(table, { ...key, user_id: "u3" })).toMatchObject({ value: 2 });
        w.delete(table, { ...key, user_id: "u3" });
        expect(rows.get(table, { ...key, user_id: "u3" })).toBeUndefined();
        expect(rows.all(table, { where: { day: key.day } })).toEqual([{ ...key, user_id: "u2", value: 20 }]);
      });
      expect(rows.get(table, key)).toBeUndefined();
      await expect(rows.write((w) => {
        w.insert(table, { ...key, value: 9 });
        expect(rows.get(table, key)).toMatchObject({ value: 9 });
        throw new Error("rollback probe");
      })).rejects.toThrow("rollback probe");
      expect(rows.get(table, key)).toBeUndefined();
      expect(rows.get(table, { ...key, user_id: "u2" })).toMatchObject({ value: 20 });
    } finally {
      await rows.close();
      db.close();
    }
  });
});
