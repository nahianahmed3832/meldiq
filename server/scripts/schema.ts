/**
 * Writes src/infrastructure/database/schema.generated.ts: every table the migrations create, as the rows layer and the
 * MongoDB catalog need it (columns, keys, indexes, foreign keys). Run after adding a migration:
 *
 *   npm run schema
 *
 * test/schema.test.ts fails while the checked-in file and the migrations disagree.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { describeTables, schemaSource } from "../src/infrastructure/database/mongo/catalog.js";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "infrastructure", "database", "schema.generated.ts");
const db = openDatabase(":memory:");
fs.writeFileSync(out, schemaSource(describeTables(db)));
db.close();
console.log(`wrote ${path.relative(process.cwd(), out)}`);
