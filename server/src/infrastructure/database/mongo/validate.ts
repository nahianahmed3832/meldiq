import type { Db, Document } from "mongodb";
import { type TableSpec } from "./catalog.js";

/** Diagnostic only. Never guesses a missing owner, deletes an orphan, or prints document content. */
export async function validateRelationships(db: Db, tables: TableSpec[]) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const results: {
    table: string;
    parent: string;
    columns: string[];
    missing: number;
  }[] = [];
  for (const table of tables)
    for (const fk of table.foreignKeys) {
      const target = byName.get(fk.table);
      if (!target) continue;
      const equality: Document[] = fk.columns.map((col, i) => ({
        $eq: [`$${fk.references[i]}`, `$$v${i}`],
      }));
      // Tenant-owned children must reference a parent in the same community.
      if (
        table.columns.some((c) => c.name === "org_id") &&
        target.columns.some((c) => c.name === "org_id")
      ) {
        equality.push({ $eq: ["$org_id", "$$community"] });
      }
      const [r] = await db
        .collection(table.name)
        .aggregate<{ n: number }>(
          [
            {
              $match: {
                $and: fk.columns.map((col) => ({ [col]: { $ne: null } })),
              },
            },
            {
              $lookup: {
                from: fk.table,
                let: {
                  ...Object.fromEntries(
                    fk.columns.map((col, i) => [`v${i}`, `$${col}`]),
                  ),
                  community: "$org_id",
                },
                pipeline: [
                  { $match: { $expr: { $and: equality } } },
                  { $limit: 1 },
                  { $project: { _id: 1 } },
                ],
                as: "migration_parent",
              },
            },
            { $match: { migration_parent: { $size: 0 } } },
            { $count: "n" },
          ],
          { maxTimeMS: 60_000, allowDiskUse: true },
        )
        .toArray();
      results.push({
        table: table.name,
        parent: fk.table,
        columns: fk.columns,
        missing: r?.n ?? 0,
      });
    }
  return results;
}
