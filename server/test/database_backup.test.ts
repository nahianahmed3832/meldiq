import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Binary, Double, Int32, Long, MongoClient, ObjectId } from "mongodb";
import { afterAll, expect, inject, it } from "vitest";
import { testDbName } from "./support/mongo.js";

const uri = inject("mongoUri");
const name = testDbName("backup");
const destination = `meldiq_restore_${Date.now()}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-backup-test-"));
const source = new MongoClient(uri);
afterAll(async () => {
  await source.db(name).dropDatabase();
  await source.db(destination).dropDatabase();
  await source.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
it(
  "restores a snapshot with exact BSON, validators, indexes, counts and checksums",
  { timeout: 60_000 },
  async () => {
    await source.connect();
    await source
      .db(name)
      .createCollection("records", {
        validator: {
          $jsonSchema: { bsonType: "object", required: ["_id", "owner"] },
        },
      });
    await source
      .db(name)
      .collection("records")
      .createIndex({ owner: 1 }, { unique: true, name: "owner_unique" });
    await source
      .db(name)
      .collection("records")
      .insertOne({
        _id: new ObjectId(),
        owner: "test-user",
        binary: new Binary(Buffer.from([1, 2, 3])),
        date: new Date(1234),
        long: Long.fromString("9007199254740993"),
        integer: new Int32(2),
        fraction: new Double(1.5),
      });
    const file = path.join(dir, "backup.gz");
    const fd = fs.openSync(file, "w", 0o600);
    const dump = spawn(
      process.execPath,
      ["scripts/database-backup.mjs", "dump"],
      {
        env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: name },
        stdio: ["ignore", fd, "pipe"],
      },
    );
    let stderr = "";
    dump.stderr.on("data", (x) => (stderr += x));
    const [code] = await once(dump, "exit");
    fs.closeSync(fd);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const restore = spawn(
      process.execPath,
      ["scripts/database-backup.mjs", "restore"],
      {
        env: {
          ...process.env,
          RESTORE_MONGODB_URI: uri,
          RESTORE_MONGODB_DB: destination,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    restore.stdout.on("data", (x) => (output += x));
    restore.stderr.on("data", (x) => (errors += x));
    fs.createReadStream(file).pipe(restore.stdin);
    const [restored] = await once(restore, "exit");
    expect(errors).toBe("");
    expect(restored).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      verified: true,
      collections: [{ collection: "records", count: 1 }],
    });
    const doc = await source
      .db(destination)
      .collection("records")
      .findOne({}, { promoteLongs: false, promoteValues: false });
    expect(doc!.long.toString()).toBe("9007199254740993");
    expect(doc!.integer).toBeInstanceOf(Int32);
    expect(doc!.binary).toBeInstanceOf(Binary);
    await expect(
      source
        .db(destination)
        .collection("records")
        .insertOne({ owner: "test-user" }),
    ).rejects.toThrow(/duplicate/);
  },
);
