import type { Db } from "mongodb";
import { GENESIS_HASH, rowHash, type AuditRow } from "./audit.js";

export async function validateAuditChain(db: Db) {
  let previous = GENESIS_HASH;
  let records = 0,
    invalid = 0;
  for await (const document of db
    .collection("platform_audit")
    .find({}, { sort: { id: 1 }, batchSize: 500 })) {
    const row = document as unknown as AuditRow;
    records++;
    if (row.prev_hash !== previous || row.hash !== rowHash(previous, row))
      invalid++;
    previous = row.hash;
  }
  return { records, invalid, ok: invalid === 0 };
}
