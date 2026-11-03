import crypto from "node:crypto";
import net from "node:net";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import pg from "pg";
import {MeldiqPostgres} from "../src/infrastructure/database/postgres/client.js";

const endpoint=new URL(process.env.MELDIQ_PG_TEST_URL??"");
if(!["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname))throw new Error("Owned loopback PostgreSQL required");
const administrator=new pg.Client({connectionString:endpoint.href});
const database="meldiq_pool_wait_"+crypto.randomBytes(8).toString("hex");
beforeAll(async()=>{await administrator.connect();await administrator.query(`CREATE DATABASE ${database}`);endpoint.pathname="/"+database;});
afterAll(async()=>{await administrator.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);await administrator.end();});

describe("bounded pool queue and socket connection waits",()=>{
  it("allows a queued request to complete after the old five-second queue limit",async()=>{
    const db=new MeldiqPostgres({url:endpoint.href,environment:"development",maxConnections:1});
    let held:pg.PoolClient|undefined;let release:ReturnType<typeof setTimeout>|undefined;
    try{
      held=await db.connect();const started=performance.now();
      release=setTimeout(()=>{held!.release();held=undefined;},6_000);
      const result=await db.query("SELECT 1 AS value");
      expect(result.rows[0].value).toBe(1);expect(performance.now()-started).toBeGreaterThan(5_500);
      expect(performance.now()-started).toBeLessThan(14_500);
    }finally{if(release)clearTimeout(release);held?.release();await db.close();}
  },16_000);
  it("still stops an unresponsive physical PostgreSQL handshake after five seconds",async()=>{
    const sockets=new Set<net.Socket>();const server=net.createServer(socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address() as net.AddressInfo;
    const db=new MeldiqPostgres({url:`postgresql://postgres@127.0.0.1:${address.port}/postgres`,environment:"development",maxConnections:1});
    try{
      const started=performance.now();await expect(db.query("SELECT 1")).rejects.toThrow();
      expect(performance.now()-started).toBeGreaterThan(4_500);expect(performance.now()-started).toBeLessThan(8_000);
    }finally{await db.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  },10_000);
});
