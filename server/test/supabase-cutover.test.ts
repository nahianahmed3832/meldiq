import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {DatabaseCutover} from "../src/app/databaseCutover.js";
import {preparePostgresHarness} from "./support/postgres.js";
import {loadConfig} from "../src/app/config.js";
import {buildApp} from "../src/app/server.js";
import {openOperatorSocket,callOperatorSocket,operatorSocketPath} from "../src/app/operatorSocket.js";
import {tableCounts} from "../src/infrastructure/database/postgres/migration.js";
import {postgresTableSpecs} from "../src/infrastructure/database/postgres/nativeCatalog.js";

const directories:string[]=[];
const project="bkvlxbsnzqkhbifawcww",source="a".repeat(64);
function folder(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"meldiq-authority-test-"));directories.push(dir);return dir;}
afterEach(()=>{for(const dir of directories.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
describe("database authority commit point",()=>{
  it("holds effects until the exact source is activated, then resumes safely after restart",async()=>{
    const dir=folder(),gate=new DatabaseCutover(dir,project,source);let starts=0;
    await gate.whenActive(()=>{starts++;});expect(starts).toBe(0);expect(gate.held).toBe(true);
    await expect(gate.activate("b".repeat(64))).rejects.toThrow("exact reconciled");expect(fs.existsSync(gate.file)).toBe(false);
    await Promise.all([gate.activate(source),gate.activate(source)]);
    expect(starts).toBe(1);expect(gate.status()).toMatchObject({held:false,activationDurable:true});
    expect(fs.statSync(gate.file).mode&0o777).toBe(0o600);
    const restarted=new DatabaseCutover(dir,project,source);expect(restarted.held).toBe(false);
    await restarted.whenActive(()=>{starts++;});expect(starts).toBe(2);
    await restarted.activate(source);expect(starts).toBe(2);
  });
  it("preserves the committed database if a background startup task fails",async()=>{
    const gate=new DatabaseCutover(folder(),project,source);
    await gate.whenActive(()=>{throw new Error("fixture background failure");});
    await expect(gate.activate(source)).rejects.toThrow("keep PostgreSQL authoritative");
    expect(gate.status()).toMatchObject({held:true,activationDurable:true});
    expect(new DatabaseCutover(gate.dataDir,project,source).held).toBe(false);
  });
  it("refuses mismatched/public receipts and cannot activate a read-only rehearsal",async()=>{
    const dir=folder(),gate=new DatabaseCutover(dir,project,source,false);
    await expect(gate.activate(source)).rejects.toThrow("read-only rehearsal");expect(fs.existsSync(gate.file)).toBe(false);
    const active=new DatabaseCutover(dir,project,source);await active.activate(source);
    expect(new DatabaseCutover(dir,project,source,false).held).toBe(true);
    expect(()=>new DatabaseCutover(dir,project,"b".repeat(64))).toThrow("does not match");
    fs.chmodSync(active.file,0o644);expect(()=>new DatabaseCutover(dir,project,source)).toThrow("private");
  });
  it("boots without application writes, holds business routes and releases through private operator IPC",async()=>{
    const storage=await preparePostgresHarness(process.env.MELDIQ_PG_TEST_URL);
    if(!storage)throw new Error("An owned loopback PostgreSQL database is required");
    const dir=folder(),gate=new DatabaseCutover(dir,project,source);
    const before=await tableCounts(storage.database,postgresTableSpecs());
    let built:Awaited<ReturnType<typeof buildApp>>|undefined,stop:(()=>Promise<void>)|undefined;
    try{
      const config=loadConfig({DATA_DIR:dir,LOG_LEVEL:"silent",TELEMETRY_TICK_MS:"0",REMINDER_TICK_MS:"0",WORKFLOW_TICK_MS:"0"});
      built=await buildApp(config,{postgres:storage.database,cutover:gate,logger:false});
      await built.app.listen({host:"127.0.0.1",port:0});stop=await openOperatorSocket(built.ctx);
      expect(await tableCounts(storage.database,postgresTableSpecs())).toEqual(before);
      expect((await built.app.inject({method:"GET",url:"/healthz"})).statusCode).toBe(200);
      expect((await built.app.inject({method:"GET",url:"/v1/server-info"})).json().maintenance.enabled).toBe(true);
      expect((await built.app.inject({method:"POST",url:"/v2/account/login",payload:{}})).statusCode).toBe(503);
      const socket=operatorSocketPath(dir);
      expect((await callOperatorSocket(socket,"reg-invite",["1","1"])).code).toBe(1);
      expect((await callOperatorSocket(socket,"database-cutover-status",[])).stdout).toContain('"held":true');
      expect((await callOperatorSocket(socket,"database-cutover-activate",["b".repeat(64)])).code).toBe(1);
      expect(gate.held).toBe(true);
      expect((await callOperatorSocket(socket,"database-cutover-activate",[source])).code).toBe(0);
      expect(gate.held).toBe(false);
      expect((await built.app.inject({method:"GET",url:"/v1/server-info"})).json().maintenance.enabled).toBe(false);
      expect(built.ctx.platform.count("telemetry_epochs")).toBeGreaterThan(0);
      expect(built.ctx.postgres!.legacySqlAttempts).toBe(0);
    }finally{await stop?.();await built?.app.close();built?.ctx.db.close();await storage.close();}
  });
});
