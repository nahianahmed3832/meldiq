import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MongoClient } from "mongodb";
import { expect, inject, it } from "vitest";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { MONGO_DOMAINS } from "../src/infrastructure/database/mongo/config.js";
import { testDbName } from "./support/mongo.js";

const execute = promisify(execFile);

it("plans and preflights without changing the source, target documents, validators or authority", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-cli-"));
  const source = path.join(directory, "snapshot.sqlite");
  const db = openDatabase(source);
  db.close();
  const checksum = () => createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  const before = checksum();
  const client = new MongoClient(inject("mongoUri"));
  await client.connect();
  const target = client.db(testDbName("readonly_cli"));
  try {
    // A native document whose contents must not be interpreted as permission to reimport stale SQL.
    await target.collection("nav_preferences").insertOne({ sentinel: "unchanged" });
    const metadata = await target.listCollections().toArray();
    const env = { ...process.env, MONGODB_URI: inject("mongoUri"), MONGODB_DB: target.databaseName, MONGODB_DOMAINS: MONGO_DOMAINS.join(",") };
    for (const command of ["plan", "preflight"]) {
      const { stdout } = await execute(process.execPath, ["--import", "tsx", "scripts/database-migration.ts", command, source], { env, maxBuffer: 2 * 1024 * 1024 });
      expect(JSON.parse(stdout).readOnly).toBe(true);
      expect(checksum()).toBe(before);
    }
    expect(await target.listCollections().toArray()).toEqual(metadata);
    expect(await target.collection("nav_preferences").findOne({})).toMatchObject({ sentinel: "unchanged" });
    await expect(execute(process.execPath, ["--import", "tsx", "scripts/database-migration.ts", "copy", source], { env })).rejects.toThrow();
    expect(await target.listCollections().toArray()).toEqual(metadata);
    expect(checksum()).toBe(before);
  } finally {
    await target.dropDatabase();
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
