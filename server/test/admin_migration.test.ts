import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

describe("administration migration 081", () => {
  it("preserves existing grants, passkeys and sessions while widening only the role constraint", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      for (const name of fs
        .readdirSync(migrations)
        .filter((f) => /^\d+_.+\.sql$/.test(f) && Number(f.split("_")[0]) < 81)
        .sort())
        db.exec(fs.readFileSync(path.join(migrations, name), "utf8"));
      db.prepare("INSERT INTO platform_admins(account_id,role,granted_by,granted_at,updated_at,note) VALUES ('acc_legacy','support_admin','acc_owner',100,200,'Existing restricted access')").run();
      db.prepare("INSERT INTO platform_admin_passkeys(id,account_id,public_key,name,created_at) VALUES ('fixture-key','acc_legacy','fixture-public-key','Existing key',100)").run();
      db.prepare(
        "INSERT INTO platform_admin_sessions(id,token_hash,account_id,created_at,last_used_at,idle_expires_at,expires_at,reauth_at,network) VALUES ('fixture-session','fixture-hash','acc_legacy',100,100,300,400,100,'127.0.0.1')",
      ).run();
      const grant = db.prepare("SELECT * FROM platform_admins").get();
      const passkey = db.prepare("SELECT * FROM platform_admin_passkeys").get();
      const session = db.prepare("SELECT * FROM platform_admin_sessions").get();
      db.transaction(() => db.exec(fs.readFileSync(path.join(migrations, "081_admin_operations.sql"), "utf8")))();
      expect(db.prepare("SELECT * FROM platform_admins").get()).toEqual({ ...(grant as object), permissions: null });
      expect(db.prepare("SELECT * FROM platform_admin_passkeys").get()).toEqual(passkey);
      expect(db.prepare("SELECT * FROM platform_admin_sessions").get()).toEqual(session);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='platform_admins_next'").get()).toBeUndefined();
      db.prepare("INSERT INTO platform_admins(account_id,role,granted_at,updated_at) VALUES ('acc_moderator','platform_moderator',100,100)").run();
      expect(() => db.prepare("INSERT INTO platform_admins(account_id,role,granted_at,updated_at) VALUES ('acc_invalid','made_up_role',100,100)").run()).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
