import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupDatabase, verifyBackup } from "../src/modules/administration/backup.js";
import { latestMigration, openDatabase } from "../src/infrastructure/database/db.js";
import { type Harness, startServer } from "./support/harness.js";

let h: Harness;
let dir: string;
/** The snapshot is of SQLite: it holds the people only while identity lives there (not in MongoDB mode). */
const sqliteUsers = () => (h.ctx.identity.backend === "sqlite" ? 2 : 0);
beforeAll(async () => {
  h = await startServer();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "griip-backup-"));
});
afterAll(async () => {
  await h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("self-host backup and restore checks", () => {
  it("snapshots a live database, keeps it owner-only and verifies it", async () => {
    await h.client("bkalice");
    await h.client("bkbob");
    const file = path.join(dir, "snap.sqlite");
    const r = await backupDatabase(h.ctx.db, file);
    expect(r.bytes).toBeGreaterThan(0);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const v = verifyBackup(file);
    expect(v).toMatchObject({ ok: true, integrity: "ok", schemaVersion: latestMigration(), users: sqliteUsers(), problems: [] });
  });

  it("never overwrites an existing file", async () => {
    const file = path.join(dir, "exists.sqlite");
    fs.writeFileSync(file, "keep me");
    await expect(backupDatabase(h.ctx.db, file)).rejects.toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(file, "utf8")).toBe("keep me");
  });

  it("a restored snapshot opens and migrates on a fresh server", async () => {
    const file = path.join(dir, "restore.sqlite");
    await backupDatabase(h.ctx.db, file);
    const db = openDatabase(file);
    expect((db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(sqliteUsers());
    expect((db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number }).v).toBe(latestMigration());
    db.close();
  });

  it("rejects missing, foreign, corrupt and newer-schema files", () => {
    expect(verifyBackup(path.join(dir, "missing.sqlite")).ok).toBe(false);
    const junk = path.join(dir, "junk.sqlite");
    fs.writeFileSync(junk, "this is not sqlite at all, just text that is long enough to have a header".repeat(20));
    expect(verifyBackup(junk).ok).toBe(false);
    const foreign = path.join(dir, "foreign.sqlite");
    const other = new Database(foreign);
    other.exec("CREATE TABLE notes (x TEXT)");
    other.close();
    expect(verifyBackup(foreign).problems.join()).toMatch(/not a Griip Message database/);
    const newer = path.join(dir, "newer.sqlite");
    const n = openDatabase(newer);
    n.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future.sql', 0)").run(latestMigration() + 1);
    n.close();
    expect(verifyBackup(newer).problems.join()).toMatch(/newer than this server/);
  });
});
