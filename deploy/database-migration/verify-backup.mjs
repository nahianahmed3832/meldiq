// Reads a decrypted gzip stream. Prints only aggregate verification; never connects to a database.
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { BSON } from "mongodb";

const stable = value => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]))
  : Array.isArray(value) ? value.map(stable) : value;
const MOD = 1n << 256n;
async function verify() {
  const gzip = createGunzip();
  const lines = createInterface({ input: process.stdin.pipe(gzip), crlfDelay: Infinity });
  let header, footer;
  const totals = new Map();
  for await (const line of lines) {
    if (footer) throw Error("Trailing data");
    const record = JSON.parse(line);
    if (record.type === "header" && !header && record.format === "meldiq-ejson-snapshot-v1") {
      header = record;
      for (const { name } of header.collections) {
        if (totals.has(name)) throw Error("Duplicate collection");
        totals.set(name, { count: 0, sum: 0n });
      }
    } else if (record.type === "document" && header && totals.has(record.collection)) {
      const doc = BSON.EJSON.parse(record.ejson, { relaxed: false });
      const canonical = JSON.stringify(stable(JSON.parse(BSON.EJSON.stringify(doc, { relaxed: false }))));
      const hash = BigInt("0x" + createHash("sha256").update(canonical).digest("hex"));
      const total = totals.get(record.collection);
      total.count++;
      total.sum = (total.sum + hash) % MOD;
    } else if (record.type === "complete" && header) footer = record;
    else throw Error("Invalid record");
  }
  if (!footer || footer.totals.length !== totals.size || new Set(footer.totals.map(t => t.collection)).size !== totals.size)
    throw Error("Incomplete backup");
  for (const expected of footer.totals) {
    const actual = totals.get(expected.collection);
    if (!actual || actual.count !== expected.count || actual.sum.toString(16).padStart(64, "0") !== expected.checksum)
      throw Error("Checksum mismatch");
  }
  console.log(JSON.stringify({ verified: true, collections: totals.size, records: [...totals.values()].reduce((n, t) => n + t.count, 0) }));
}
verify().catch(error => {
  console.error(JSON.stringify({ verified: false, errorType: error.name }));
  process.exitCode = 1;
});
