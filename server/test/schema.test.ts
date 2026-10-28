import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { describeTables, schemaSource, TABLE_DOMAINS, tableSpecs } from "../src/infrastructure/database/mongo/catalog.js";
import { checkReferences } from "../src/infrastructure/database/mongo/index.js";

/**
 * The server runs on the checked-in schema (src/infrastructure/database/schema.generated.ts), not on what a SQLite file
 * says: it must be exactly what the migrations create. After adding a migration: npm run schema.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(here, "..", "src", "infrastructure", "database", "schema.generated.ts");

describe("checked-in schema", () => {
  it("is what the migrations create (run `npm run schema` after adding a migration)", () => {
    // Arrange
    const db = openDatabase(":memory:");

    // Act
    const fromMigrations = schemaSource(describeTables(db));
    db.close();

    // Assert
    expect(fs.readFileSync(SCHEMA_FILE, "utf8")).toBe(fromMigrations);
  });

  it("gives every table its domain without a database", () => {
    const specs = tableSpecs();
    expect(specs.length).toBeGreaterThan(100);
    for (const t of specs) expect(t.domain, t.name).toBe(TABLE_DOMAINS[t.name]);
  });

  it("matches the live schema table by table, keys and indexes included", () => {
    const db = openDatabase(":memory:");
    const live = describeTables(db);
    db.close();
    expect(tableSpecs()).toEqual(live);
  });
});

describe("which domains may be in MongoDB together", () => {
  const all = ["preferences", "reports", "relationships", "history", "accounts", "files", "relay", "billing", "platform", "federation", "calls", "workspace", "conversations", "safety", "ephemeral", "identity"];

  it("refuses identity in MongoDB while tables that reference it are still in SQLite", () => {
    expect(() => checkReferences(tableSpecs(), new Set(["identity"]))).toThrow(/"identity" is referenced from/);
    expect(() => checkReferences(tableSpecs(), new Set(all.filter((d) => d !== "ephemeral")))).toThrow(/"ephemeral"/);
  });

  it("accepts every stage of the cutover runbook, and everything at once", () => {
    const stages = [
      ["preferences", "reports", "relationships", "history", "accounts", "files", "relay", "billing"],
      ["platform", "federation"],
      ["calls"],
      ["workspace", "conversations"],
      ["safety", "ephemeral", "identity"],
    ];
    const inMongo = new Set<string>();
    for (const stage of stages) {
      for (const d of stage) inMongo.add(d);
      expect(() => checkReferences(tableSpecs(), inMongo)).not.toThrow();
    }
    expect([...inMongo].sort()).toEqual([...all].sort());
  });
});
