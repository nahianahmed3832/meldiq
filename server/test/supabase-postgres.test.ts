import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { registerSupabaseTransport } from "../src/modules/auth/supabaseRoutes.js";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { MeldiqPostgres } from "../src/infrastructure/database/postgres/client.js";
import { PostgresRows } from "../src/infrastructure/database/rows/postgresRows.js";
import { tableSpecs } from "../src/infrastructure/database/mongo/catalog.js";
import { PostgresMessageStore } from "../src/modules/messaging/store/postgresStore.js";
import type { MessageEvent } from "../src/modules/messaging/store/messageStore.js";
import { PostgresOutbox } from "../src/infrastructure/database/postgres/outbox.js";
import { SupabaseAccessVerifier } from "../src/infrastructure/database/postgres/auth.js";
import { PostgresDocuments } from "../src/infrastructure/database/postgres/documents.js";
import type { ProgramApplication } from "../src/modules/accounts/creators/service.js";
import { TypedPostgresImporter, digest, validateRow, dependencyOrder } from "../src/infrastructure/database/postgres/migration.js";

const root = process.env.MELDIQ_SUPABASE_WEB_ROOT ?? path.resolve(process.cwd(), "../../meldiq_web");
const connection = process.env.MELDIQ_PG_TEST_URL;
if (!connection) throw new Error("Set MELDIQ_PG_TEST_URL to a loopback PostgreSQL administrator URL for synthetic tests");
const endpoint = new URL(connection);
if (!["localhost","127.0.0.1","[::1]"].includes(endpoint.hostname)) throw new Error("Tests refuse non-loopback PostgreSQL");
const database = `meldiq_supabase_test_${process.pid}`;
const admin = new pg.Pool({connectionString:connection,max:1});
endpoint.pathname = `/${database}`;
let db: MeldiqPostgres;
let messages: PostgresMessageStore;
const auth1 = "10000000-0000-4000-8000-000000000001";
const auth2 = "10000000-0000-4000-8000-000000000002";
const session = "20000000-0000-4000-8000-000000000001";

async function claims<T>(uid: string, run: () => Promise<T>) { return db.asUser(uid,uid===auth1?session:"20000000-0000-4000-8000-000000000002",run); }
function event(id: string, extra: Partial<MessageEvent> = {}): MessageEvent {
  return {id,conversation_id:"conversation1",sender_user_id:"user1",sender_device_id:"device1",cls:"message",type:"text",target:null,audience:"all",payload:JSON.stringify({type:"text",text:"hello"}),sent_at:1000,server_ts:1000,mention_all:0,imported_by:null,...extra};
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  db = new MeldiqPostgres({url:endpoint.href,environment:"development",maxConnections:6});
  await db.query(fs.readFileSync(path.join(root,"scripts/supabase/postgres-bootstrap.sql"),"utf8"));
  for (const file of fs.readdirSync(path.join(root,"supabase/migrations")).filter(f=>f.endsWith(".sql")).sort()) {
    await db.transaction(async () => { await db.query(fs.readFileSync(path.join(root,"supabase/migrations",file),"utf8")); });
  }
  messages = new PostgresMessageStore(db);
});
afterAll(async () => {
  await db?.close();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
});
beforeEach(async () => {
  const tables = await db.query<{schema:string;name:string}>("SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname IN ('meldiq','meldiq_private','auth')");
  await db.query(`TRUNCATE ${tables.rows.map(t=>`"${t.schema}"."${t.name}"`).join(",")} RESTART IDENTITY CASCADE`);
  await db.query("TRUNCATE realtime.test_sent");
  for (let n=1;n<=2;n++) {
    await db.query(`INSERT INTO meldiq.users(id,username,display_name,identity_key,avatar_color,created_at,updated_at) VALUES($1,$1,$1,$1,1,1000,1000)`,[`user${n}`]);
    await db.query("INSERT INTO meldiq.accounts(id,email,name,password_hash,password_changed_at,user_id,created_at,updated_at) VALUES($1,$2,$1,'!synthetic-fixture',1000,$3,1000,1000)",[`account${n}`,`fixture${n}@example.invalid`,`user${n}`]);
    const uid=n===1?auth1:auth2;
    await db.query("INSERT INTO auth.users(id) VALUES($1)",[uid]);
    await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)",[n===1?session:"20000000-0000-4000-8000-000000000002",uid]);
    await db.query("INSERT INTO meldiq_private.auth_links(auth_user_id,account_id,user_id,verified_at,method) VALUES($1,$2,$3,now(),'verified_recovery')",[uid,`account${n}`,`user${n}`]);
  }
  await db.query("INSERT INTO meldiq.conversations(id,type,created_by,created_at,updated_at) VALUES('conversation1','DM','user1',1000,1000)");
  await db.query("INSERT INTO meldiq.conversation_members(conversation_id,user_id,role,joined_at) VALUES('conversation1','user1','MEMBER',1000),('conversation1','user2','MEMBER',1000)");
});

describe("relational schema and security",()=>{
  it("enforces RLS and denies raw client access on every application and operational table",async()=>{
    const rows=await db.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS exposed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('meldiq','meldiq_private') AND c.relkind='r'");
    expect(rows.rows.length).toBe(276);
    expect(rows.rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity&&!r.exposed)).toBe(true);
    await expect(claims(auth1,()=>db.query("SELECT password_hash FROM meldiq.accounts"))).rejects.toMatchObject({code:"42501"});
    await expect(claims(auth1,()=>db.query("UPDATE meldiq.billing_subscriptions SET status='active'"))).rejects.toMatchObject({code:"42501"});
    await expect(claims(auth1,()=>db.query("DELETE FROM meldiq.platform_audit"))).rejects.toMatchObject({code:"42501"});
  });
  it("permits the trusted API role without granting bypassrls",async()=>{
    const role=await db.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='meldiq_api'"); expect(role.rows[0].rolbypassrls).toBe(false);
    await db.transaction(async()=>{await db.query("SET LOCAL ROLE meldiq_api");expect((await db.query("SELECT count(*) AS n FROM meldiq.users")).rows[0].n).toBe(2);});
  });
  it("preserves foreign keys and check constraints",async()=>{
    await expect(db.query("INSERT INTO meldiq.conversation_members(conversation_id,user_id,role,joined_at) VALUES('missing','user1','MEMBER',1)")).rejects.toMatchObject({code:"23503"});
    await expect(db.query("UPDATE meldiq.conversations SET type='INVALID'")).rejects.toMatchObject({code:"23514"});
  });
  it("preserves ASCII case-insensitive uniqueness",async()=>{
    await expect(db.query("UPDATE meldiq.users SET username='USER1' WHERE id='user2'")).rejects.toMatchObject({code:"23505"});
  });
  it("rejects mismatched identity ownership and duplicate account mappings",async()=>{
    await expect(db.query("UPDATE meldiq_private.auth_links SET user_id='user2' WHERE auth_user_id=$1",[auth1])).rejects.toMatchObject({code:"23514"});
    await expect(db.query("UPDATE meldiq_private.auth_links SET account_id='account1',user_id='user1' WHERE auth_user_id=$1",[auth2])).rejects.toMatchObject({code:"23505"});
  });
  it("limits private user topics and blocks forged message broadcasts",async()=>{
    const can=async(uid:string,topic:string,extension:string,send=false)=>claims(uid,async()=> (await db.query("SELECT meldiq_private.can_join_topic($1,$2,$3) AS ok",[topic,extension,send])).rows[0].ok);
    expect(await can(auth1,"user:user1","broadcast")).toBe(true);
    expect(await can(auth2,"user:user1","broadcast")).toBe(false);
    expect(await can(auth1,"user:user1","broadcast",true)).toBe(false);
    expect(await can(auth1,"conversation:conversation1","broadcast")).toBe(false);
    await db.query("INSERT INTO meldiq_private.realtime_grants VALUES($1,'conversation:conversation1',now()+interval '1 minute',false,false)",[auth1]);
    expect(await can(auth1,"conversation:conversation1","broadcast")).toBe(true);
    expect(await can(auth1,"conversation:conversation1","broadcast",true)).toBe(false);
  });
  it("applies actual Realtime insert policies, not just helper predicates",async()=>{
    await expect(claims(auth1,async()=>{await db.query("SELECT set_config('realtime.topic','user:user1',true)");await db.query("INSERT INTO realtime.messages(extension) VALUES('broadcast')");})).rejects.toMatchObject({code:"42501"});
    await db.query("INSERT INTO meldiq_private.realtime_grants VALUES($1,'ephemeral:conversation1',now()+interval '1 minute',true,true)",[auth1]);
    await claims(auth1,async()=>{await db.query("SELECT set_config('realtime.topic','ephemeral:conversation1',true)");await db.query("INSERT INTO realtime.messages(extension) VALUES('presence')");});
  });
  it("denies expired grants, revoked sessions and suspended/deleted users",async()=>{
    await db.query("INSERT INTO meldiq_private.realtime_grants VALUES($1,'conversation:conversation1',now()-interval '1 minute',false,false)",[auth1]);
    const can=(topic:string)=>claims(auth1,async()=> (await db.query("SELECT meldiq_private.can_join_topic($1,'broadcast',false) AS ok",[topic])).rows[0].ok);
    expect(await can("conversation:conversation1")).toBe(false);
    await db.query("INSERT INTO meldiq_private.revoked_auth_sessions(session_id,auth_user_id) VALUES($1,$2)",[session,auth1]);
    expect(await can("user:user1")).toBe(false);
    await db.query("DELETE FROM meldiq_private.revoked_auth_sessions");
    await db.query("UPDATE meldiq.accounts SET disabled_at=1 WHERE id='account1'");expect(await can("user:user1")).toBe(false);
    await db.query("UPDATE meldiq.accounts SET disabled_at=NULL WHERE id='account1'");
    await db.query("UPDATE meldiq.users SET deleted_at=1 WHERE id='user1'");expect(await can("user:user1")).toBe(false);
  });
  it("never leaks per-request claims into a pooled connection",async()=>{
    expect(await claims(auth1,async()=> (await db.query("SELECT meldiq_private.active_user_id() AS id")).rows[0].id)).toBe("user1");
    expect((await db.query("SELECT meldiq_private.active_user_id() AS id")).rows[0].id).toBeNull();
  });
});

describe("message durability and outbox recovery",()=>{
  it("commits one event and one pair of jobs under concurrent duplicate requests",async()=>{
    const added=await Promise.all(Array.from({length:20},()=>messages.add(event("message0001"))));
    expect(added.filter(Boolean)).toHaveLength(1);
    expect(await messages.stats()).toEqual({messages:1,changes:0});
    expect((await db.query("SELECT count(*) AS n FROM meldiq_private.outbox")).rows[0].n).toBe(2);
  });
  it("rolls the message back if outbox insertion fails",async()=>{
    await expect(messages.add(event("a".repeat(9000)))).rejects.toMatchObject({code:"23514"});
    expect(await messages.stats()).toEqual({messages:0,changes:0});
  });
  it("preserves timestamp tie pagination, changes, read receipts and self privacy",async()=>{
    await messages.addMany([event("message0001"),event("message0002"),event("message0003"),event("control0001",{cls:"control",type:"edit",target:"message0002",payload:'{"type":"edit","text":"new"}'}),event("private0001",{cls:"control",type:"read",audience:"self",payload:'{"type":"read","upTo":1000}'}),event("read000001",{cls:"control",type:"read",sender_user_id:"user2",payload:'{"type":"read","upTo":1000}'})]);
    const first=await messages.page("conversation1","user2",null,2);expect(first.messages.map(m=>m.id)).toEqual(["message0003","message0002"]);
    expect(first.changes.map(m=>m.id)).toEqual(["control0001"]);
    expect((await messages.page("conversation1","user2",1000,2,"message0002")).messages.map(m=>m.id)).toEqual(["message0001"]);
    expect((await messages.around("conversation1","user1","message0002",1))?.messages.map(m=>m.id)).toEqual(["message0003","message0002","message0001"]);
  });
  it("does not notify for imported history",async()=>{
    await messages.add(event("imported001",{imported_by:"user1"}));
    expect((await db.query("SELECT count(*) AS n FROM meldiq_private.outbox")).rows[0].n).toBe(0);
  });
  it("searches literal text and reports unread, mentions, thread and activity",async()=>{
    await messages.add(event("message0001",{sender_user_id:"user2",payload:'{"type":"text","text":"100% hello","mentions":["user1"],"threadRoot":"root000001"}'}));
    expect(await messages.search(["conversation1"],"100%",10)).toHaveLength(1);expect(await messages.search(["missing"],"hello",10)).toHaveLength(0);
    expect((await messages.summaries(["conversation1"],"user1",99))[0]).toMatchObject({unread:1,mentions:1});
    expect(await messages.threadHasReplies("conversation1","root000001",1)).toBe(true);
    expect(await messages.lastMessageAt(["conversation1"])).toEqual({conversation1:1000});
    expect((await messages.activitySince(["conversation1"],1,10)).topSenders).toEqual([{userId:"user2",count:1}]);
  });
  it("orders claims and prevents competing workers from claiming one event",async()=>{
    await messages.addMany([event("message0001"),event("message0002")]);
    const a=new PostgresOutbox(db),b=new PostgresOutbox(db);
    const claimed=(await Promise.all([a.claim("realtime"),b.claim("realtime")])).flat();expect(claimed).toHaveLength(1);
    expect(await a.publishRealtime(claimed[0])).toBe(true);
    const next=await a.claim("realtime");expect(next).toHaveLength(1);expect(next[0].sequence).toBeGreaterThan(claimed[0].sequence);
    expect(await a.publishRealtime(claimed[0])).toBe(false);
    expect((await db.query("SELECT * FROM realtime.test_sent")).rows[0]).toMatchObject({private:true,topic:"conversation:conversation1",payload:{messageId:"message0001"}});
  });
  it("recovers an expired lease and rejects acknowledgment by the old worker",async()=>{
    await messages.add(event("message0001"));const outbox=new PostgresOutbox(db);const [old]=await outbox.claim("realtime");
    await db.query("UPDATE meldiq_private.outbox SET lease_until=now()-interval '1 second' WHERE sequence=$1",[old.sequence]);
    const [fresh]=await outbox.claim("realtime");expect(fresh.event_id).toBe(old.event_id);expect(fresh.lease_id).not.toBe(old.lease_id);
    expect(await outbox.acknowledge(old)).toBe(false);expect(await outbox.publishRealtime(fresh)).toBe(true);
  });
  it("dead-letters failed events and replays without overtaking",async()=>{
    await messages.addMany([event("message0001"),event("message0002")]);const outbox=new PostgresOutbox(db,1);const [first]=await outbox.claim("realtime");
    await outbox.fail(first);expect(await outbox.claim("realtime")).toHaveLength(0);
    expect((await db.query("SELECT dead_at,last_error_code FROM meldiq_private.outbox WHERE sequence=$1",[first.sequence])).rows[0]).toMatchObject({last_error_code:"unavailable",dead_at:expect.any(Date)});
    await outbox.replay(first.sequence);expect((await outbox.runRealtimeOnce()).delivered).toBe(1);
    expect((await outbox.runRealtimeOnce()).delivered).toBe(1);
  });
});

describe("PostgresRows compatibility",()=>{
  it("persists synchronous units, enforces one writer, survives a restart and rolls back rejected changes",async()=>{
    const rows=await PostgresRows.open(db,tableSpecs());
    try {
      await expect(PostgresRows.open(db,tableSpecs())).rejects.toThrow("Another synchronous repository writer");
      await rows.write(w=>{w.update("users",{id:"user1"},{display_name:"changed"});});
      expect(rows.get<{display_name:string}>("users",{id:"user1"})?.display_name).toBe("changed");
      await expect(rows.write(w=>{w.update("users",{id:"user1"},{display_name:"discard"});throw new Error("test rollback");})).rejects.toThrow("test rollback");
      expect(rows.get<{display_name:string}>("users",{id:"user1"})?.display_name).toBe("changed");
    } finally {await rows.close();}
    const reopened=await PostgresRows.open(db,tableSpecs());
    try {expect(reopened.get<{display_name:string}>("users",{id:"user1"})?.display_name).toBe("changed");} finally {await reopened.close();}
  });
  it("refuses unsafe integers and insecure remote TLS overrides",async()=>{
    await expect(db.query("SELECT 9007199254740993::bigint")).rejects.toThrow("safe range");
    expect(()=>new MeldiqPostgres({url:"postgresql://x@y.example/db?sslmode=no-verify",environment:"staging"})).toThrow("TLS");
    expect(()=>new MeldiqPostgres({url:endpoint.href,environment:"production"})).toThrow("development database");
  });
});

describe("Supabase JWT validation",()=>{
  it("checks signatures, issuer, audience, expiry, key rotation, subject ownership and revocation",async()=>{
    const first=await generateKeyPair("ES256"),second=await generateKeyPair("ES256");
    const jwks=createLocalJWKSet({keys:[{...await exportJWK(first.publicKey),kid:"first",alg:"ES256"},{...await exportJWK(second.publicKey),kid:"second",alg:"ES256"}]});
    const verifier=new SupabaseAccessVerifier("https://staging.example.invalid",db,jwks);
    const sign=async(extra:Record<string,unknown>={},rotated=false)=>new SignJWT({role:"authenticated",session_id:session,...extra}).setProtectedHeader({alg:"ES256",kid:rotated?"second":"first"}).setIssuer("https://staging.example.invalid/auth/v1").setAudience("authenticated").setSubject(auth1).setIssuedAt().setExpirationTime("5m").sign(rotated?second.privateKey:first.privateKey);
    expect(await verifier.verify(await sign())).toMatchObject({userId:"user1",accountId:"account1"});
    expect(await verifier.verify(await sign({},true))).toMatchObject({userId:"user1"});
    expect(await verifier.verify(await sign({role:"service_role"}))).toBeNull();
    await db.query("UPDATE auth.sessions SET not_after=now()-interval '1 second' WHERE id=$1",[session]);
    expect(await verifier.verify(await sign())).toBeNull();
    await db.query("UPDATE auth.sessions SET not_after=NULL WHERE id=$1",[session]);
    const expired=await new SignJWT({role:"authenticated",session_id:session}).setProtectedHeader({alg:"ES256",kid:"first"}).setSubject(auth1).setIssuer("https://staging.example.invalid/auth/v1").setAudience("authenticated").setIssuedAt(1).setExpirationTime(2).sign(first.privateKey);
    expect(await verifier.verify(expired)).toBeNull();
    const other=await new SignJWT({role:"authenticated",session_id:session}).setProtectedHeader({alg:"ES256",kid:"first"}).setSubject(auth1).setIssuer("https://wrong.example.invalid/auth/v1").setAudience("authenticated").setIssuedAt().setExpirationTime("5m").sign(first.privateKey);
    expect(await verifier.verify(other)).toBeNull();
    const tampered=(await sign()).split(".");tampered[2]=crypto.randomBytes(64).toString("base64url");expect(await verifier.verify(tampered.join("."))).toBeNull();
    await db.query("INSERT INTO meldiq_private.revoked_auth_sessions(session_id,auth_user_id) VALUES($1,$2)",[session,auth1]);
    expect(await verifier.verify(await sign())).toBeNull();
  });
});

describe("repeatable migration and record-level reconciliation",()=>{
  const spec=tableSpecs().find(t=>t.name==="users")!;
  const run=()=>({id:crypto.randomUUID(),sourceSha256:digest("frozen synthetic source"),catalogSha256:digest(JSON.stringify(tableSpecs())),environment:"development" as const});
  it("imports an immutable batch and resumes without duplicate records",async()=>{
    const importer=new TypedPostgresImporter(db),r=run();await importer.start(r);
    const user=(await db.query("SELECT * FROM meldiq.users WHERE id='user1'")).rows[0];
    const source={...user,id:"user3",username:"user3",identity_key:"key3"};
    expect(await importer.batch(r.id,spec,0,[source])).toMatchObject({inserted:1,resumed:false});
    expect(await importer.batch(r.id,spec,0,[source])).toMatchObject({inserted:0,resumed:true});
    expect((await db.query("SELECT count(*) AS n FROM meldiq.users")).rows[0].n).toBe(3);
  });
  it("detects changed snapshots and changed completed batches",async()=>{
    const importer=new TypedPostgresImporter(db),r=run();await importer.start(r);
    await expect(importer.start({...r,sourceSha256:digest("changed")})).rejects.toThrow("source changed");
    const user=(await db.query("SELECT * FROM meldiq.users WHERE id='user1'")).rows[0];await importer.batch(r.id,spec,0,[user]);
    await expect(importer.batch(r.id,spec,0,[{...user,display_name:"different"}])).rejects.toThrow("source changed");
  });
  it("detects content differences even when record counts match and preserves the destination",async()=>{
    const importer=new TypedPostgresImporter(db),r=run();await importer.start(r);
    const user=(await db.query("SELECT * FROM meldiq.users WHERE id='user1'")).rows[0];
    await expect(importer.batch(r.id,spec,0,[{...user,display_name:"conflicting"}])).rejects.toThrow("keyDigest=");
    expect((await db.query("SELECT display_name FROM meldiq.users WHERE id='user1'")).rows[0].display_name).toBe("user1");
    expect((await db.query("SELECT count(*) AS n FROM meldiq_private.migration_batches")).rows[0].n).toBe(0);
  });
  it("rolls back an entire failed batch and its checkpoint",async()=>{
    const importer=new TypedPostgresImporter(db),r=run();await importer.start(r);
    const user=(await db.query("SELECT * FROM meldiq.users WHERE id='user1'")).rows[0];
    await expect(importer.batch(r.id,spec,0,[{...user,id:"user3",username:"user3",identity_key:"key3"},{...user,id:"user4",username:"user4",kind:"invalid"}])).rejects.toMatchObject({code:"23514"});
    expect((await db.query("SELECT count(*) AS n FROM meldiq.users")).rows[0].n).toBe(2);
  });
  it("rejects unknown columns, unsafe money/times and missing values",async()=>{
    const user=(await db.query("SELECT * FROM meldiq.users WHERE id='user1'")).rows[0];
    expect(()=>validateRow(spec,{...user,unmapped:"not dropped"})).toThrow("Unmapped");
    expect(()=>validateRow(spec,{...user,created_at:Number.MAX_SAFE_INTEGER+1})).toThrow("Unsafe");
    const missing={...user};delete missing.username;expect(()=>validateRow(spec,missing)).toThrow("Missing");
  });
  it("orders every relational dependency and refuses incomplete plans",()=>{
    const ordered=dependencyOrder(tableSpecs()),seen=new Set<string>();
    for(const t of ordered){expect(t.foreignKeys.every(f=>seen.has(f.table))).toBe(true);seen.add(t.name);}
    expect(ordered).toHaveLength(246);
    expect(()=>dependencyOrder([tableSpecs().find(t=>t.name==="org_members")!])).toThrow("dependency");
  });
  it("refuses imports while the synchronous runtime writer is active",async()=>{
    const importer=new TypedPostgresImporter(db),r=run();await importer.start(r);
    const rows=await PostgresRows.open(db,tableSpecs());
    try{const user=(await db.query("SELECT * FROM meldiq.users WHERE id='user1'")).rows[0];await expect(importer.batch(r.id,spec,0,[user])).rejects.toThrow("Stop the repository writer");}
    finally{await rows.close();}
  });
});


describe("Fastify Supabase identity and realtime boundary",()=>{
  it("uses signed identity, rejects unauthorized topics and never accepts client role claims",async()=>{
    const pair=await generateKeyPair("ES256");
    const jwks=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:"test",alg:"ES256"}]});
    const verifier=new SupabaseAccessVerifier("https://staging.example.invalid",db,jwks);
    const token=await new SignJWT({role:"authenticated",session_id:session,user_metadata:{userId:"user2",admin:true}}).setProtectedHeader({alg:"ES256",kid:"test"}).setIssuer("https://staging.example.invalid/auth/v1").setAudience("authenticated").setSubject(auth1).setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
    const app=Fastify({logger:false});
    await registerSupabaseTransport(app,{postgres:db,verifier,authorizeRealtime:async(principal,id)=>{
      const member=await db.query("SELECT 1 FROM meldiq.conversation_members WHERE user_id=$1 AND conversation_id=$2",[principal.userId,id]);
      if(!member.rowCount)throw Object.assign(new Error("Not found"),{statusCode:404});
      return {presence:true,typing:true};
    }});
    try {
      expect((await app.inject({method:"GET",url:"/v3/auth/me",headers:{'x-user-id':"user1"}})).statusCode).toBe(401);
      const own=await app.inject({method:"GET",url:"/v3/auth/me",headers:{authorization:`Bearer ${token}`}});
      expect(own.json()).toEqual({authUserId:auth1,accountId:"account1",userId:"user1"});expect(own.headers["cache-control"]).toBe("private, no-store");
      expect((await app.inject({method:"POST",url:"/v3/realtime/grants",headers:{authorization:`Bearer ${token}`},payload:{conversationId:"missing"}})).statusCode).toBe(404);
      expect((await app.inject({method:"POST",url:"/v3/realtime/grants",headers:{authorization:`Bearer ${token}`},payload:{conversationId:"conversation1",role:"ADMIN"}})).statusCode).toBe(400);
      const grant=await app.inject({method:"POST",url:"/v3/realtime/grants",headers:{authorization:`Bearer ${token}`},payload:{conversationId:"conversation1"}});
      expect(grant.statusCode).toBe(200);expect(grant.json()).toEqual({topics:["conversation:conversation1","ephemeral:conversation1"],expiresIn:120});
      expect((await db.query("SELECT count(*) AS n FROM meldiq_private.realtime_grants WHERE auth_user_id=$1",[auth1])).rows[0].n).toBe(2);
    }finally{await app.close();}
  });
});


describe("normalized native keyed stores",()=>{
  it("preserves creator application uniqueness and atomic one-use state changes",async()=>{
    const store=new PostgresDocuments<ProgramApplication>(db,"creator_program");
    const app:ProgramApplication={id:"application1",userId:"user1",status:"pending",reason:null,createdAt:1000,reviewedAt:null,reviewedBy:null};
    await store.insert(app);expect(await store.get(app.id)).toEqual(app);
    await expect(store.insert({...app,id:"application2"})).rejects.toThrow("Duplicate");
    expect(await store.update(app.id,{status:"approved"},{status:"rejected"})).toBeNull();
    const wins=await Promise.all([store.update(app.id,{status:"pending"},{status:"approved"}),store.update(app.id,{status:"pending"},{status:"rejected"})]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await store.find({userId:"user1"},{newestBy:"createdAt",limit:10})).toHaveLength(1);
    expect(await store.count({userId:"user1"})).toBe(1);
    const takes=await Promise.all([store.take(app.id),store.take(app.id)]);expect(takes.filter(Boolean)).toHaveLength(1);
  });
});
