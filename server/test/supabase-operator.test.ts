import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { startServer } from "./support/harness.js";
import { preparePostgresHarness } from "./support/postgres.js";
import { callOperatorSocket, openOperatorSocket, operatorSocketPath } from "../src/modules/administration/operatorSocket.js";

const execute = promisify(execFile);
describe("PostgreSQL operator commands share the active writer", () => {
  it("preserves standalone legacy commands before cutover",async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"meldiq-legacy-operator-"));
    try {
      const env={PATH:process.env.PATH,DATA_DIR:dir,DATABASE_MODE:"hybrid",APP_ENV:"development"};
      const invoke=(...args:string[])=>execute(process.execPath,["--import","tsx","src/admin.ts",...args],{cwd:process.cwd(),env,timeout:10_000});
      expect((await invoke("stats")).stdout).toContain("activeDevices");
      await invoke("reg-invite","1","1","legacy operator test");
      expect((await invoke("reg-invites")).stdout).toContain("legacy operator test");
      expect((await invoke("platform-audit-verify")).stdout).toContain('"brokenAt": null');
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
  it("persists administrative changes, captures private output and preserves the running API", async () => {
    const storage = await preparePostgresHarness(process.env.MELDIQ_PG_TEST_URL);
    if (!storage) throw new Error("A loopback PostgreSQL test database is required");
    const h = await startServer({}, { postgres: storage.database });
    let stop: (() => Promise<void>) | undefined;
    try {
      const file = operatorSocketPath(h.dir);
      stop = await openOperatorSocket(h.ctx);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const before = h.ctx.identity.count("registration_invites");
      const invitation = await callOperatorSocket(file, "reg-invite", ["1", "1", "operator test"]);
      expect(invitation.code).toBe(0);
      expect(invitation.stdout).toContain("registration");
      expect(h.ctx.identity.count("registration_invites")).toBe(before + 1);
      expect(Number((await storage.database.query<{ n: string }>("SELECT count(*)::text AS n FROM meldiq.registration_invites")).rows[0].n)).toBe(before + 1);
      const failed = await callOperatorSocket(file, "disable", ["no-such-user"]);
      expect(failed).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("no such user"),
      });
      for (const command of ["stats", "platform-admin-list", "platform-audit-verify", "reg-invites", "table-counts"]) {
        const result = await callOperatorSocket(file, command, []);
        expect(result.code, command + ": " + result.stderr).toBe(0);
      }
      const cli = await execute(process.execPath, ["--import", "tsx", "src/admin.ts", "reg-invites"], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          DATABASE_MODE: "supabase",
          DATA_DIR: h.dir,
        },
        timeout: 10_000,
      });
      expect(cli.stdout).toContain("operator test");
      const legacy = await callOperatorSocket(file, "mongo-migrate", []);
      expect(legacy.code).toBe(1);
      expect(legacy.stderr).toContain("active PostgreSQL authority");
      expect((await fetch(h.baseUrl + "/healthz")).ok).toBe(true);
      expect(h.ctx.postgres!.legacySqlAttempts).toBe(0);
      expect(h.ctx.postgres!.rows.available).toBe(true);
      await stop();
      stop = undefined;
      await expect(callOperatorSocket(file, "stats", [])).rejects.toThrow();
      expect((await fetch(h.baseUrl + "/healthz")).ok).toBe(true);
    } finally {
      await stop?.();
      await h.close();
      await storage.close();
    }
  });
  it("refuses to replace a regular file at the private socket path", async () => {
    const storage = await preparePostgresHarness(process.env.MELDIQ_PG_TEST_URL);
    if (!storage) throw new Error("A loopback PostgreSQL test database is required");
    const h = await startServer({}, { postgres: storage.database });
    try {
      const file = operatorSocketPath(h.dir);
      fs.mkdirSync(h.dir + "/.ops", {mode:0o700});
      fs.writeFileSync(file, "preserve");
      await expect(openOperatorSocket(h.ctx)).rejects.toThrow("unsafe");
      expect(fs.readFileSync(file, "utf8")).toBe("preserve");
    } finally {
      await h.close();
      await storage.close();
    }
  });
});
