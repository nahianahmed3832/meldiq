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
import { PostgresFileStore } from "../src/modules/files/postgresStore.js";
import { KEPT_FOREVER, type UploadRow } from "../src/modules/files/store.js";
import { startFakeS3 } from "./support/fakeS3.js";
import { expectStatus, startServer } from "./support/harness.js";
import { processBlobDeletes } from "../src/modules/files/routes.js";
import { PostgresPreferenceStore } from "../src/modules/accounts/preferences/postgresStore.js";
import { zNavPrefs } from "../src/modules/accounts/preferences/schema.js";
import { PostgresActivityStore } from "../src/modules/accounts/activity/postgresStore.js";
import { PostgresUsernameHoldStore } from "../src/modules/accounts/postgresUsernameHoldStore.js";
import { PostgresHistoryStore } from "../src/modules/messaging/history/postgresStore.js";
import { PostgresRelationshipStore } from "../src/modules/accounts/relationships/postgresStore.js";
import { pairOf } from "../src/modules/accounts/relationships/store.js";
import { PostgresReportStore } from "../src/modules/organizations/reports/postgresStore.js";
import type { ReportRow } from "../src/modules/organizations/reports/store.js";
import { PostgresRecoveryStore } from "../src/modules/accounts/postgresRecoveryStore.js";
import { RECOVERY_TICKET_GRACE_MS } from "../src/modules/accounts/recoveryStore.js";
import { PostgresKeyBackupStore } from "../src/modules/accounts/postgresKeyBackupStore.js";
import { PostgresAccountStore } from "../src/modules/accounts/postgresStore.js";
import type { AccountRow, SessionRow } from "../src/modules/accounts/store.js";
import { SocialStore, type SocialFlow } from "../src/modules/accounts/social/store.js";
import type { AppContext } from "../src/app/context.js";
import { PostgresRelayStore } from "../src/modules/messaging/relay/postgresStore.js";
import type { QueueInsert, Submission } from "../src/modules/messaging/relay/store.js";
import { PostgresCallStore } from "../src/modules/calls/postgresStore.js";
import type { CallRow } from "../src/modules/calls/store.js";
import { postgresTableSpecs } from "../src/infrastructure/database/postgres/nativeCatalog.js";
import { PostgresPrivacyStore } from "../src/modules/accounts/relationships/postgresPrivacyStore.js";
import { PostgresFavoriteStore } from "../src/modules/accounts/decorations/postgresFavoritesStore.js";
import { PostgresOAuthStore } from "../src/modules/oauth/postgresStore.js";
import { OAuthService } from "../src/modules/oauth/service.js";
import { token as oauthToken } from "../src/modules/oauth/flow.js";
import { secretHash } from "../src/shared/utilities/secrets.js";
import type { OAuthApp } from "../src/modules/oauth/store.js";
import { PostgresBotStore } from "../src/modules/bots/postgresStore.js";
import { PostgresRulesStore } from "../src/modules/organizations/rules/postgresStore.js";
import { PostgresPinStore } from "../src/modules/accounts/pins/postgresStore.js";
import { PostgresPointsStore } from "../src/modules/points/postgresStore.js";
import { PostgresDecorationStore } from "../src/modules/accounts/decorations/postgresStore.js";
import type { PointsEntry } from "../src/modules/points/store.js";
import { openPostgresRuntime } from "../src/app/postgresRuntime.js";
import type { ProgramApplication } from "../src/modules/accounts/creators/service.js";
import { TypedPostgresImporter, digest, validateRow, dependencyOrder } from "../src/infrastructure/database/postgres/migration.js";
import { assertSyntheticStagingDatabase } from "../src/infrastructure/database/postgres/sourceSnapshot.js";

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
const deletionOrder = new Map(dependencyOrder(postgresTableSpecs()).reverse().map((table, index) => [table.name, index]));

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
  const schemaOrder: Record<string, number> = {meldiq_private: 0, meldiq: 1, auth: 2};
  tables.rows.sort((a, b) => schemaOrder[a.schema] - schemaOrder[b.schema] || (deletionOrder.get(a.name) ?? 0) - (deletionOrder.get(b.name) ?? 0) || a.name.localeCompare(b.name));
  // These are small synthetic fixtures in a freshly created loopback database. Truncating 284 relations for
  // every test rewrites thousands of physical files and dominated the suite under concurrent workstation load.
  // Row deletion retains all FK/trigger enforcement; flush deferred cleanup, then remove its synthetic queue work.
  await db.transaction(async () => {
    await db.query("SET CONSTRAINTS ALL DEFERRED");
    // This freshly owned loopback test database deliberately resets immutable audit fixtures as its administrator.
    await db.query("ALTER TABLE meldiq.platform_audit DISABLE TRIGGER platform_audit_no_delete");
    await db.query(tables.rows.map(t => `DELETE FROM "${t.schema}"."${t.name}";`).join("\n"));
    await db.query("ALTER TABLE meldiq.platform_audit ENABLE TRIGGER platform_audit_no_delete");
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("DELETE FROM meldiq.pending_blob_deletes; DELETE FROM meldiq.abandoned_uploads; DELETE FROM realtime.test_sent; DELETE FROM realtime.messages;");
  });
  for (let n=1;n<=2;n++) {
    await db.query(`INSERT INTO meldiq.users(id,username,display_name,identity_key,avatar_color,created_at,updated_at) VALUES($1,$1,$1,$1,1,1000,1000)`,[`user${n}`]);
    await db.query("INSERT INTO meldiq.accounts(id,email,name,password_hash,password_changed_at,user_id,created_at,updated_at) VALUES($1,$2,$1,'!synthetic-fixture',1000,$3,1000,1000)",[`account${n}`,`fixture${n}@example.invalid`,`user${n}`]);
    const uid=n===1?auth1:auth2;
    await db.query("INSERT INTO auth.users(id) VALUES($1)",[uid]);
    await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)",[n===1?session:"20000000-0000-4000-8000-000000000002",uid]);
    await db.query("INSERT INTO meldiq_private.auth_links(auth_user_id,account_id,user_id,verified_at,method) VALUES($1,$2,$3,now(),'verified_recovery')",[uid,`account${n}`,`user${n}`]);
    await db.query("INSERT INTO meldiq.devices(id,user_id,name,signing_key,encryption_key,certificate,created_at) VALUES($1,$2,'Synthetic fixture',$3,$3,'Synthetic certificate',1000)", [`fixture-device-${n}`, `user${n}`, `fixture-public-key-${n}`]);
    await db.query("INSERT INTO meldiq.auth_device_sessions(id,auth_user_id,account_id,user_id,device_id,link_method,password_changed_at,bound_at) VALUES($1,$2,$3,$4,$5,'existing_mapping',1000,1000)", [n===1?session:"20000000-0000-4000-8000-000000000002", uid, `account${n}`, `user${n}`, `fixture-device-${n}`]);
  }
  await db.query("INSERT INTO meldiq.conversations(id,type,created_by,created_at,updated_at) VALUES('conversation1','DM','user1',1000,1000)");
  await db.query("INSERT INTO meldiq.conversation_members(conversation_id,user_id,role,joined_at) VALUES('conversation1','user1','MEMBER',1000),('conversation1','user2','MEMBER',1000)");
});

describe("relational schema and security",()=>{
  it("protects customer rehearsals from synthetic imports and API smoke startup",async()=>{
    await assertSyntheticStagingDatabase(db);
    await db.query("UPDATE meldiq.accounts SET email='customer@private.test' WHERE id='account1'");
    await expect(assertSyntheticStagingDatabase(db)).rejects.toThrow("protected");
    await db.query("UPDATE meldiq.accounts SET email='fixture1@example.invalid' WHERE id='account1'");
    await db.query("COMMENT ON SCHEMA meldiq IS 'Meldiq customer-data rehearsal: synthetic guard test'");
    try{await expect(assertSyntheticStagingDatabase(db)).rejects.toThrow("protected");}
    finally{await db.query("COMMENT ON SCHEMA meldiq IS NULL");}
  });
  it("enforces RLS and denies raw client access on every application and operational table",async()=>{
    const rows=await db.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS exposed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('meldiq','meldiq_private') AND c.relkind='r'");
    expect(rows.rows.length).toBe(289);
    expect(rows.rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity&&!r.exposed)).toBe(true);
    await expect(claims(auth1,()=>db.query("SELECT password_hash FROM meldiq.accounts"))).rejects.toMatchObject({code:"42501"});
    await expect(claims(auth1,()=>db.query("UPDATE meldiq.billing_subscriptions SET status='active'"))).rejects.toMatchObject({code:"42501"});
    await expect(claims(auth1,()=>db.query("DELETE FROM meldiq.platform_audit"))).rejects.toMatchObject({code:"42501"});
  });
  it("permits the trusted API role without granting bypassrls",async()=>{
    const role=await db.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='meldiq_api'"); expect(role.rows[0].rolbypassrls).toBe(false);
    await db.transaction(async()=>{await db.query("SET LOCAL ROLE meldiq_api");expect((await db.query("SELECT count(*) AS n FROM meldiq.users")).rows[0].n).toBe(2);});
  });
  it("keeps platform audit append-only and published financial terms immutable", async () => {
    await db.query("INSERT INTO meldiq.platform_audit(id,at,action,outcome,prev_hash,hash) VALUES(1,1000,'synthetic','success','previous','hash')");
    await db.query("INSERT INTO meldiq.billing_plans(id,key,name,status,created_by,created_at,updated_at) VALUES('synthetic-plan','synthetic-plan','Synthetic','active','user1',1000,1000)");
    await db.query(`INSERT INTO meldiq.billing_plan_versions(id,plan_id,version,interval,currency,amount_minor,created_by,created_at,updated_at,published_at)
      VALUES('synthetic-price','synthetic-plan',1,'month','USD',1250,'user1',1000,1000,1000)`);
    await expect(db.query("UPDATE meldiq.platform_audit SET reason='changed' WHERE id=1")).rejects.toMatchObject({code: "23514"});
    await expect(db.query("DELETE FROM meldiq.platform_audit WHERE id=1")).rejects.toMatchObject({code: "23514"});
    for (const change of ["amount_minor=1", "provider='changed'", "quota_plan_id='changed'", "limits='changed'", "currency='EUR'", "billing_frequency=3"]) {
      await expect(db.query(`UPDATE meldiq.billing_plan_versions SET ${change} WHERE id='synthetic-price'`)).rejects.toMatchObject({code: "23514"});
    }
    await db.query("UPDATE meldiq.billing_plan_versions SET notes='Retired offer',retired_at=2000 WHERE id='synthetic-price'");
    expect((await db.query("SELECT amount_minor FROM meldiq.billing_plan_versions WHERE id='synthetic-price'")).rows[0].amount_minor).toBe(1250);
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
  it("keeps compatibility delivery on its existing relay without accumulating duplicate native jobs",async()=>{
    const compatible=new MeldiqPostgres({...db.config,deliveryMode:"legacy"});
    try{
      const store=new PostgresMessageStore(compatible);
      expect(await store.add(event("message0001"))).toBe(true);
      expect(await store.add(event("message0001"))).toBe(false);
      expect((await store.get("message0001"))?.payload).toBe(event("message0001").payload);
      expect((await db.query("SELECT count(*) AS n FROM meldiq_private.outbox")).rows[0].n).toBe(0);
    }finally{await compatible.close();}
  });
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
  it("publishes the stored invalidation with the restricted backend's RLS and ignores caller payload substitution", async () => {
    await messages.add(event("message0001"));
    const [claimed] = await new PostgresOutbox(db).claim("realtime");
    const restricted = new MeldiqPostgres({url: endpoint.href, environment: "development", maxConnections: 2});
    const transaction = restricted.transaction.bind(restricted);
    restricted.transaction = run => transaction(async client => {await client.query("SET LOCAL ROLE meldiq_api"); return run(client);});
    try {
      expect(await new PostgresOutbox(restricted).publishRealtime({...claimed, topic: "user:foreign", payload: {secret: "must not publish"}})).toBe(true);
      expect((await db.query("SELECT * FROM realtime.test_sent")).rows).toEqual([{private: true, topic: "conversation:conversation1", event: "message.changed",
        payload: {eventId: claimed.event_id, messageId: "message0001", conversationId: "conversation1"}}]);
      await expect(restricted.transaction(async client => {await client.query(`INSERT INTO realtime.messages(id,payload,event,topic,private,extension)
        VALUES($1,$2::jsonb,'message.changed','conversation:conversation1',true,'broadcast')`, [crypto.randomUUID(), JSON.stringify({eventId: crypto.randomUUID(), messageId: "forged", conversationId: "conversation1"})]);})).rejects.toMatchObject({code: "42501"});
    } finally {await restricted.close();}
  });
  it("rolls back broadcast insertion and acknowledgment together when enqueue fails", async () => {
    await messages.add(event("message0001"));
    const outbox = new PostgresOutbox(db), [claimed] = await outbox.claim("realtime");
    await db.query(`CREATE FUNCTION realtime.test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic enqueue failure'; END $$;
      CREATE TRIGGER test_reject BEFORE INSERT ON realtime.messages FOR EACH ROW EXECUTE FUNCTION realtime.test_reject();`);
    try {
      await expect(outbox.publishRealtime(claimed)).rejects.toMatchObject({code: "P0001"});
      expect((await db.query("SELECT delivered_at FROM meldiq_private.outbox WHERE sequence=$1", [claimed.sequence])).rows[0].delivered_at).toBeNull();
      expect((await db.query("SELECT count(*) AS count FROM realtime.test_sent")).rows[0].count).toBe(0);
    } finally {await db.query("DROP TRIGGER test_reject ON realtime.messages; DROP FUNCTION realtime.test_reject()");}
    expect(await outbox.publishRealtime(claimed)).toBe(true);
  });
  it("never publishes a push-destination claim through Realtime", async () => {
    await messages.add(event("message0001"));
    const outbox = new PostgresOutbox(db), [push] = await outbox.claim("push");
    expect(await outbox.publishRealtime(push)).toBe(false);
    expect((await db.query("SELECT delivered_at FROM meldiq_private.outbox WHERE sequence=$1", [push.sequence])).rows[0].delivered_at).toBeNull();
    expect((await db.query("SELECT count(*) AS count FROM realtime.test_sent")).rows[0].count).toBe(0);
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
  it("loads multiple cursor pages and keeps durable counters ahead of retained rows", async () => {
    await db.query(`INSERT INTO meldiq.users(id,username,display_name,identity_key,avatar_color,created_at,updated_at)
      SELECT 'paged-user-'||n,'paged-user-'||n,'Synthetic fixture','paged-key-'||n,1,1000,1000 FROM generate_series(1,1001) n`);
    await db.query("INSERT INTO meldiq.audit_log(id,at,action) SELECT n,1000,'synthetic' FROM generate_series(1,501) n");
    await db.query("INSERT INTO meldiq_private.row_counters(table_name,value) VALUES('audit_log',5000)");
    const rows = await PostgresRows.open(db, tableSpecs());
    try {
      expect(rows.count("users")).toBe(1003);
      expect(rows.get("users", {id: "paged-user-1001"})).toMatchObject({identity_key: "paged-key-1001"});
      expect(rows.count("audit_log")).toBe(501);
      const saved = await rows.write(writer => writer.insert("audit_log", {at: 1001, action: "next synthetic"}));
      expect(saved.id).toBe(5001);
    } finally { await rows.close(); }
  });
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
    expect(()=>new MeldiqPostgres({url:"postgresql://x@y.example:6543/db",environment:"staging"})).toThrow("session-pool");
  });
  it("overrides pooler float truncation on every new lease before reading rows",async()=>{
    const candidate=new MeldiqPostgres({url:endpoint.href,environment:"development",maxConnections:1});
    // Emulate the hosted pool's server-session default, which ignores startup float precision.
    candidate.pool.on("connect",client=>{void client.query("SET extra_float_digits=0");});
    try {
      for(let pass=0;pass<2;pass++){
        const lease=await candidate.connect();
        try {
          const result=(await lease.query("SELECT current_setting('extra_float_digits') AS precision,1.2345678901234567::double precision AS value")).rows[0];
          expect(result.precision).toBe("3");expect(result.value).toBe(1.2345678901234567);
        }finally{lease.release(true);}
      }
    }finally{await candidate.close();}
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
    expect(ordered).toHaveLength(257);
    expect(()=>dependencyOrder([tableSpecs().find(t=>t.name==="org_members")!])).toThrow("dependency");
  });
  it("preserves empty and nested JSONB arrays through import and resume",async()=>{
    const importer=new TypedPostgresImporter(db),r=run();await importer.start(r);
    const botSpec=postgresTableSpecs().find(table=>table.name==="bots")!;
    const row={id:"user1",owner_id:"user2",token_hash:"synthetic_bot_hash",created_at:123,token_rotated_at:123,public:false,commands:[]};
    await importer.batch(r.id,botSpec,0,[row]);
    expect((await db.query("SELECT commands FROM meldiq.bots WHERE id='user1'")).rows[0].commands).toEqual([]);
    await importer.batch(r.id,botSpec,0,[row]);
    const nested={...row,id:"user2",token_hash:"synthetic_bot_hash_two",commands:[{name:"test",options:[{kind:"text",choices:[]}]}]};
    await importer.batch(r.id,botSpec,1,[nested]);
    expect((await db.query("SELECT commands FROM meldiq.bots WHERE id='user2'")).rows[0].commands).toEqual(nested.commands);
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
    expect(await store.update(app.id,{status:"approved"},{})).toBeNull();
    await expect(store.insert({...app,id:"application2"})).rejects.toThrow("Duplicate");
    expect(await store.update(app.id,{status:"approved"},{status:"rejected"})).toBeNull();
    const wins=await Promise.all([store.update(app.id,{status:"pending"},{status:"approved"}),store.update(app.id,{status:"pending"},{status:"rejected"})]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await store.find({userId:"user1"},{newestBy:"createdAt",limit:10})).toHaveLength(1);
    expect(await store.count({userId:"user1"})).toBe(1);
    const takes=await Promise.all([store.take(app.id),store.take(app.id)]);expect(takes.filter(Boolean)).toHaveLength(1);
  });
});

describe("PostgreSQL attachment metadata and durable S3 cleanup", () => {
  const upload = (id: string, extra: Partial<UploadRow> = {}): UploadRow => ({
    id, user_id: "user1", device_id: "device1", conversation_id: "conversation1", size: 1_025_048_576,
    sha256: "synthetic-checksum", multipart_id: "original-s3-multipart-id", part_size: 8_388_608,
    created_at: 1000, expires_at: 2000, ...extra,
  });
  const attachment = (id: string) => ({ id, conversation_id: "conversation1", uploader_user_id: "user1", size: 1_025_048_576, created_at: 1500, expires_at: 5000 });

  it("retains exact ciphertext size and multipart IDs without moving object contents", async () => {
    const files = new PostgresFileStore(db), row = upload("large");
    await files.startUpload(row);
    expect(await files.upload(row.id)).toEqual(row);
    await files.setMultipart(row.id, "same-bucket-new-multipart-id");
    expect((await files.upload(row.id))?.multipart_id).toBe("same-bucket-new-multipart-id");
    expect(await files.pendingUsage({uploaders: ["user1"], conversations: ["conversation1"], liveAt: 1999})).toEqual({count: 1, bytes: 1_025_048_576});
    expect(await files.completeUpload(row.id, attachment(row.id))).toBe(true);
    expect(await files.completeUpload(row.id, attachment(row.id))).toBe(false);
    expect(await files.upload(row.id)).toBeNull();
    expect(await new PostgresFileStore(db).attachment(row.id)).toEqual({...attachment(row.id), kept: 0, pending_message_until: null, message_id: null, sha256: null});
    expect(await files.attachmentIdsIn(["conversation1"])).toEqual([row.id]);
    expect(await files.knows(row.id)).toBe(true);
    expect(await files.knows("missing")).toBe(false);
  });
  it("rolls back removal when attachment insertion fails", async () => {
    const files = new PostgresFileStore(db), row = upload("duplicate");
    await files.startUpload(row);
    await files.recordAttachment(attachment(row.id));
    await expect(files.completeUpload(row.id, attachment(row.id))).rejects.toMatchObject({code: "23505"});
    expect(await files.upload(row.id)).toEqual(row);
    await expect(files.completeUpload(row.id, attachment("different-id"))).rejects.toThrow("retain its upload ID");
    expect(await files.upload(row.id)).toEqual(row);
  });
  it("keeps unsent uploads temporary and preserves their digest across completion and publication", async () => {
    const files=new PostgresFileStore(db),row=upload("pending-publication");
    const stored={...attachment(row.id),pending_message_until:5000,sha256:"synthetic-content-digest"};
    await files.startUpload(row);expect(await files.completeUpload(row.id,stored)).toBe(true);
    expect(await files.attachment(row.id)).toMatchObject({pending_message_until:5000,message_id:null,sha256:stored.sha256,expires_at:5000});
    expect(await files.keepAllForever(1500)).toBe(0);
    await files.publish(row.id,"original-message",9000);
    await files.publish(row.id,"reshared-message",6000);
    expect(await files.attachment(row.id)).toMatchObject({pending_message_until:null,message_id:"original-message",sha256:stored.sha256,expires_at:9000});
    expect(await files.keepAllForever(1500)).toBe(1);
    expect((await files.attachment(row.id))?.expires_at).toBe(KEPT_FOREVER);
    expect(await files.dueAbandoned(0,10)).toEqual([]);
  });
  it("expires unpublished objects and lets explicit keep end their temporary state",async()=>{
    const files=new PostgresFileStore(db);
    await files.recordAttachment({...attachment("never-sent"),pending_message_until:5000,sha256:"kept-digest"});
    await files.recordAttachment({...attachment("explicitly-kept"),pending_message_until:5000,sha256:"other-digest"});
    await files.keep("explicitly-kept",9000);
    expect((await files.attachment("explicitly-kept"))?.pending_message_until).toBeNull();
    expect(await files.purgeExpired(5000)).toEqual(["never-sent"]);
    expect(await files.attachment("explicitly-kept")).toMatchObject({kept:1,expires_at:9000,sha256:"other-digest"});
    expect(await files.dueBlobDeletes(0,10)).toEqual([{kind:"attachments",blob_id:"never-sent",attempts:0}]);
  });
  it("allows exactly one of simultaneous completion and expiry, with recoverable cleanup", async () => {
    const files = new PostgresFileStore(db);
    for (let n = 0; n < 12; n++) {
      const id = `race-${n}`;
      await files.startUpload(upload(id));
      const [completed, expired] = await Promise.all([files.completeUpload(id, attachment(id)), files.expireUploads(2000)]);
      expect(Number(completed) + expired).toBe(1);
      expect(await files.upload(id)).toBeNull();
      const cleanup = (await files.dueAbandoned(0, 100)).some(row => row.id === id);
      expect(cleanup).toBe(!completed);
      expect((await files.attachment(id)) !== null).toBe(completed);
    }
  });
  it("ignores stale cancellation after completion and takes multipart state from the database", async () => {
    const files = new PostgresFileStore(db), row = upload("cancel");
    await files.startUpload(row);
    await files.setMultipart(row.id, "authoritative-multipart-id");
    await files.abandonUpload({...row, multipart_id: "stale-multipart-id"});
    expect(await files.dueAbandoned(0, 10)).toEqual([{id: row.id, multipart_id: "authoritative-multipart-id", attempts: 0}]);
    await files.startUpload(upload("completed"));
    await files.completeUpload("completed", attachment("completed"));
    await files.abandonUpload(upload("completed"));
    expect((await files.dueAbandoned(0, 10)).map(row => row.id)).toEqual([row.id]);
    expect(await files.attachment("completed")).not.toBeNull();
  });
  it("preserves usage filters, retry state, and extended retention", async () => {
    const files = new PostgresFileStore(db);
    await files.recordAttachment(attachment("kept"));
    await files.recordAttachment({...attachment("expired"), size: 12, expires_at: 1500});
    await files.keep("kept", 9000);
    await files.keep("kept", 6000);
    expect((await files.attachment("kept"))?.expires_at).toBe(9000);
    expect(await files.storedUsage({uploaders: ["user1"], conversations: ["conversation1"], createdAfter: 1499, liveAt: 1500, kept: true})).toEqual({count: 1, bytes: 1_025_048_576});
    expect(await files.storedUsage({uploaders: []})).toEqual({count: 0, bytes: 0});
    expect(await files.pendingUsage({conversations: []})).toEqual({count: 0, bytes: 0});
    expect(await files.keepAllForever(1500)).toBe(1);
    expect((await files.attachment("kept"))?.expires_at).toBe(KEPT_FOREVER);
    expect(await files.purgeExpired(1500)).toEqual(["expired"]);
    await files.blobDeleteRetry("attachments", "expired", 3, 4000);
    await files.enqueueBlobDelete("attachments", "expired");
    expect(await files.dueBlobDeletes(3999, 10)).toEqual([]);
    expect(await new PostgresFileStore(db).dueBlobDeletes(4000, 10)).toEqual([{kind: "attachments", blob_id: "expired", attempts: 3}]);
    await files.blobDeleteDone("attachments", "expired");
    expect(await files.dueBlobDeletes(4000, 10)).toEqual([]);
  });
  it("atomically forgets conversation metadata and keeps cleanup durable across store restarts", async () => {
    const files = new PostgresFileStore(db);
    await files.recordAttachment(attachment("stored"));
    await files.startUpload(upload("unfinished"));
    await db.query("INSERT INTO meldiq.conversations(id,type,created_by,created_at,updated_at) VALUES('other','DM','user2',1000,1000)");
    await files.startUpload(upload("other-conversation", {conversation_id: "other", user_id: "user2"}));
    files.forgetConversation("conversation1");
    files.queueBlobDelete("profile-photos", "existing-photo-key");
    await files.settled();
    const restarted = new PostgresFileStore(db);
    expect(await restarted.attachment("stored")).toBeNull();
    expect(await restarted.upload("unfinished")).toBeNull();
    expect(await restarted.upload("other-conversation")).not.toBeNull();
    expect(await restarted.dueBlobDeletes(0, 10)).toEqual([{kind: "attachments", blob_id: "stored", attempts: 0}, {kind: "profile-photos", blob_id: "existing-photo-key", attempts: 0}]);
    expect(await restarted.dueAbandoned(0, 10)).toEqual([{id: "unfinished", multipart_id: "original-s3-multipart-id", attempts: 0}]);
    await restarted.abandonedRetry("unfinished", 2, 3000);
    expect(await restarted.dueAbandoned(2999, 10)).toEqual([]);
    expect(await restarted.dueAbandoned(3000, 10)).toEqual([{id: "unfinished", multipart_id: "original-s3-multipart-id", attempts: 2}]);
    await restarted.abandonedDone("unfinished");
    restarted.forgetUploader("user2");
    await restarted.settled();
    expect(await restarted.upload("other-conversation")).toBeNull();
    expect(await restarted.dueAbandoned(0, 10)).toHaveLength(1);
  });
  it("keeps metadata and cleanup in the caller's database transaction", async () => {
    const files = new PostgresFileStore(db);
    await files.recordAttachment(attachment("rollback"));
    await expect(db.transaction(async () => {
      await files.forgetConversationAsync("conversation1");
      throw new Error("service failed");
    })).rejects.toThrow("service failed");
    expect(await files.attachment("rollback")).not.toBeNull();
    expect(await files.dueBlobDeletes(0, 10)).toEqual([]);
    // Fault injection: a denied queue must roll back the metadata removal, rather than orphan the object.
    await expect(db.transaction(async () => {
      await db.query("REVOKE INSERT ON meldiq.pending_blob_deletes FROM meldiq_api");
      await db.query("SET LOCAL ROLE meldiq_api");
      await files.purgeExpired(5000);
    })).rejects.toMatchObject({code: "42501"});
    expect(await files.attachment("rollback")).not.toBeNull();
  });
  it("reports deferred cleanup failure instead of acknowledging successful persistence", async () => {
    const files = new PostgresFileStore(db);
    // Database check rejects this impossible blob kind. No raw query error reaches a logger.
    files.queueBlobDelete("invalid" as "attachments", "test-key");
    await expect(files.settled()).rejects.toThrow("cleanup was not persisted");
    expect(await files.dueBlobDeletes(0, 10)).toEqual([]);
    await expect(files.dueBlobDeletes(0, -1)).rejects.toThrow("Cleanup limit");
  });
  it("queues cleanup during foreign-key cascades without relying on process-local callbacks", async () => {
    const files = new PostgresFileStore(db);
    await files.recordAttachment(attachment("parent-deleted"));
    await files.startUpload(upload("upload-parent-deleted"));
    await db.transaction(async () => {
      await db.query("SET LOCAL ROLE meldiq_api");
      await db.query("DELETE FROM meldiq.conversations WHERE id='conversation1'");
    });
    expect(await files.attachment("parent-deleted")).toBeNull();
    expect(await files.upload("upload-parent-deleted")).toBeNull();
    expect(await files.dueBlobDeletes(0, 10)).toEqual([{kind: "attachments", blob_id: "parent-deleted", attempts: 0}]);
    expect(await files.dueAbandoned(0, 10)).toEqual([{id: "upload-parent-deleted", multipart_id: "original-s3-multipart-id", attempts: 0}]);
  });
  it("does not queue a live attachment when a deferred upload deletion becomes a completed file", async () => {
    const files = new PostgresFileStore(db);
    await files.startUpload(upload("complete-transaction"));
    await db.transaction(async () => {
      await db.query("SET LOCAL ROLE meldiq_api");
      expect(await files.completeUpload("complete-transaction", attachment("complete-transaction"))).toBe(true);
    });
    expect(await files.dueAbandoned(0, 10)).toEqual([]);
    expect(await files.dueBlobDeletes(0, 10)).toEqual([]);
    await db.transaction(async () => {
      await db.query("DELETE FROM meldiq.attachments WHERE id='complete-transaction'");
      await files.recordAttachment(attachment("complete-transaction"));
    });
    expect(await files.dueBlobDeletes(0, 10)).toEqual([]);
  });
});

describe("Fastify attachment routes with PostgreSQL metadata and SigV4 S3 transport", () => {
  it("preserves upload limits, private downloads, multipart cancellation and failed-upload cleanup", async () => {
    const s3 = await startFakeS3("migration-fixture", "eu-central-1", {accessKeyId: "SYNTHETIC", secretAccessKey: "synthetic-secret"});
    const files = new PostgresFileStore(db);
    const h = await startServer({STORAGE_BACKEND: "s3", S3_BUCKET: "migration-fixture", S3_REGION: "eu-central-1", S3_ENDPOINT: s3.url,
      S3_FORCE_PATH_STYLE: "true", S3_ACCESS_KEY_ID: "SYNTHETIC", S3_SECRET_ACCESS_KEY: "synthetic-secret"}, {files});
    try {
      const alice = await h.client("pgfilesalice"), bob = await h.client("pgfilesbob"), eve = await h.client("pgfileseve");
      const dm = (await alice.req("POST", "/v1/conversations/dm", {userId: bob.userId})).conversation.id;
      // This test isolates the metadata repository. The other domains still use the legacy test harness;
      // mirror only synthetic FK parents, without representing this as a complete PostgreSQL application run.
      for (const userId of [alice.userId, bob.userId, eve.userId]) await db.query(
        "INSERT INTO meldiq.users(id,username,display_name,identity_key,avatar_color,created_at,updated_at) VALUES($1,$1,$1,$1,1,1000,1000)", [userId]);
      await db.query("INSERT INTO meldiq.conversations(id,type,created_by,created_at,updated_at) VALUES($1,'DM',$2,1000,1000)", [dm, alice.userId]);
      const body = Buffer.from("synthetic encrypted attachment bytes");
      const sha256 = crypto.createHash("sha256").update(body).digest("base64");
      const started = await alice.req("POST", "/v1/attachments/uploads", {conversationId: dm, size: body.length, sha256});
      expect(started.mode).toBe("single");
      expect((await fetch(started.upload.url, {method: "PUT", headers: started.upload.headers, body})).status).toBe(200);
      const completed = await alice.req("POST", `/v1/attachments/uploads/${started.uploadId}/complete`, {});
      expect(completed.size).toBe(body.length);
      expect((await files.attachment(started.uploadId))?.uploader_user_id).toBe(alice.userId);
      expect(await alice.req("POST", `/v1/attachments/uploads/${started.uploadId}/complete`, {})).toEqual(completed);
      await expectStatus(eve.req("GET", `/v1/attachments/${started.uploadId}`), 404);
      const download = await fetch(`${h.baseUrl}/v1/attachments/${started.uploadId}?proxy=1`, {headers: {authorization: `Bearer ${bob.token}`}});
      expect(download.status).toBe(200);
      expect(download.headers.get("cache-control")).toBe("private, no-store");
      expect(Buffer.from(await download.arrayBuffer())).toEqual(body);
      const memberLink = await fetch(`${h.baseUrl}/v1/attachments/${started.uploadId}`, {headers: {authorization: `Bearer ${bob.token}`}, redirect: "manual"});
      expect(memberLink.status).toBe(302);
      const location = memberLink.headers.get("location")!;
      expect(location).toContain("X-Amz-Signature");
      expect(Buffer.from(await (await fetch(location)).arrayBuffer())).toEqual(body);

      const plaintextMax = 1_000_000_000, encryptedMax = plaintextMax + 16 * Math.ceil(plaintextMax / 1_048_576);
      const large = await alice.req("POST", "/v1/attachments/uploads", {conversationId: dm, size: encryptedMax, sha256});
      expect(large.mode).toBe("multipart");
      expect((await files.upload(large.uploadId))?.size).toBe(encryptedMax);
      await expectStatus(alice.req("POST", "/v1/attachments/uploads", {conversationId: dm, size: encryptedMax + 1, sha256}), 413);
      await expectStatus(bob.req("GET", `/v1/attachments/uploads/${large.uploadId}/parts`), 404);
      await alice.req("DELETE", `/v1/attachments/uploads/${large.uploadId}`);
      expect(s3.uploads.size).toBe(0);
      expect(await files.upload(large.uploadId)).toBeNull();
      // An uploaded object that never completed is removed by the same durable retry job after expiry.
      const abandoned = await alice.req("POST", "/v1/attachments/uploads", {conversationId: dm, size: body.length, sha256});
      expect((await fetch(abandoned.upload.url, {method: "PUT", headers: abandoned.upload.headers, body})).status).toBe(200);
      await files.expireUploads(Number.MAX_SAFE_INTEGER);
      const { processAbandonedUploads } = await import("../src/modules/files/routes.js");
      await processAbandonedUploads(h.ctx);
      expect((await files.dueAbandoned(Date.now(), 10)).length).toBe(0);
      expect(s3.objects.size).toBe(1);
      await files.forgetConversationAsync(dm);
      expect(await processBlobDeletes(h.ctx)).toBe(1);
      expect(s3.objects.size).toBe(0);
    } finally {
      await h.close();
      await s3.close();
    }
  });
});

describe("PostgreSQL preferences, activity and username reservations", () => {
  it("resolves competing first writes and updates without losing a device's revision", async () => {
    const preferences = new PostgresPreferenceStore(db), prefs = zNavPrefs.parse({starred: ["conversation1"], saved: []});
    const first = await Promise.all([preferences.put("user1", "personal", prefs, 0, 1000), preferences.put("user1", "personal", zNavPrefs.parse({}), 0, 1001)]);
    expect(first.filter(result => result.ok)).toHaveLength(1);
    expect(first.filter(result => !result.ok).every(result => result.current?.rev === 1)).toBe(true);
    const second = await Promise.all([preferences.put("user1", "personal", prefs, 1, 1002), preferences.put("user1", "personal", prefs, 1, 1003)]);
    expect(second.filter(result => result.ok)).toHaveLength(1);
    expect((await new PostgresPreferenceStore(db).get("user1", "personal"))?.rev).toBe(2);
    expect(await preferences.put("user2", "personal", prefs, 4, 1000)).toEqual({ok: false, current: null});
    await expect(preferences.put("user1", "personal", prefs, Number.MAX_SAFE_INTEGER, 1000)).rejects.toThrow("revision");
  });
  it("keeps saved preferences isolated per owner/workspace and tolerates malformed historical JSON", async () => {
    const preferences = new PostgresPreferenceStore(db), prefs = zNavPrefs.parse({});
    await preferences.put("user1", "workspace", prefs, 0, 1000);
    await preferences.put("user2", "workspace", prefs, 0, 1000);
    await preferences.put("user1", "personal", prefs, 0, 1000);
    await db.query("UPDATE meldiq.nav_preferences SET doc='malformed historical JSON' WHERE user_id='user1' AND workspace_id='personal'");
    expect((await preferences.get("user1", "personal"))?.prefs).toEqual(prefs);
    await preferences.deleteForMember("user1", "workspace");
    expect(await preferences.get("user1", "workspace")).toBeNull();
    expect(await preferences.get("user2", "workspace")).not.toBeNull();
    await preferences.deleteForWorkspace("workspace");
    expect(await preferences.get("user2", "workspace")).toBeNull();
    await preferences.deleteForUser("user1");
    expect(await preferences.get("user1", "personal")).toBeNull();
  });
  it("restores live activities after restart and expires them at the exact boundary", async () => {
    const activities = new PostgresActivityStore(db);
    const entry = {userId: "user1", activity: {kind: "playing" as const, name: "Synthetic game", startedAt: 1000}, updatedAt: 1500, expiresAt: 2000};
    await activities.put(entry);
    expect(await new PostgresActivityStore(db).live(1999)).toEqual([entry]);
    expect(await activities.live(2000)).toEqual([]);
    await activities.put({...entry, expiresAt: 3000});
    await activities.removeLapsed(2000);
    expect(await activities.live(2000)).toHaveLength(1);
    await activities.removeLapsed(3000);
    expect(await activities.live(0)).toEqual([]);
    await activities.put(entry);
    await activities.remove(entry.userId);
    expect(await activities.live(0)).toEqual([]);
  });
  it("persists username holds, replacement, owner removal and expiry without a second durable database", async () => {
    const holds = new PostgresUsernameHoldStore(db), hold = {username: "reserved", userId: "user1", createdAt: 1000, expiresAt: 2000};
    await holds.put(hold);
    expect(await new PostgresUsernameHoldStore(db).live(1999)).toEqual([hold]);
    expect(await holds.live(2000)).toEqual([]);
    await holds.put({...hold, userId: "user2", expiresAt: 3000});
    await holds.deleteForUser("user1");
    expect((await holds.live(2000))[0].userId).toBe("user2");
    await holds.removeExpired(3000);
    expect(await holds.live(0)).toEqual([]);
    await holds.put(hold);
    await holds.remove(hold.username);
    expect(await holds.live(0)).toEqual([]);
  });
});

describe("PostgreSQL opaque encrypted history", () => {
  const limits = {maxItems: 1000, maxBytes: 1_000_000, maxTotalBytes: 0};
  const item = (tag: string, body: Buffer | null = Buffer.from([0, 255, 127, 0, 80])) => ({tag, conv: "opaque-conversation-tag", ts: 1000, body});
  it("keeps ciphertext and per-account cursors stable across restart, updates and tombstones", async () => {
    const history = new PostgresHistoryStore(db), first = item("opaque-tag");
    expect(await history.put("user1", [first, item("empty", Buffer.alloc(0))], limits, 1000)).toEqual({seq: 2, items: 2, bytes: 5});
    expect(await history.put("user1", [item("opaque-tag", null)], limits, 1100)).toEqual({seq: 3, items: 1, bytes: 0});
    const restarted = new PostgresHistoryStore(db);
    expect(await restarted.account("user1")).toEqual({next_seq: 4, items: 1, bytes: 0});
    expect(await restarted.items("user1", 0, 10)).toEqual([
      {tag: "empty", conv_tag: first.conv, seq: 2, ts: 1000, body: Buffer.alloc(0)},
      {tag: first.tag, conv_tag: first.conv, seq: 3, ts: 1000, body: null},
    ]);
    expect(await restarted.items("user2", 0, 10)).toEqual([]);
    expect(await restarted.purgeTombstones(1099)).toBe(0);
    expect(await restarted.purgeTombstones(1100)).toBe(1);
    expect(await restarted.put("user1", [first], limits, 1200)).toEqual({seq: 4, items: 2, bytes: 5});
    expect((await restarted.items("user1", 3, 10))[0].body).toEqual(first.body);
  });
  it("serializes competing writes before checking per-account limits", async () => {
    const history = new PostgresHistoryStore(db), small = {...limits, maxItems: 1};
    const results = await Promise.all([history.put("user1", [item("a")], small, 1000), history.put("user1", [item("b")], small, 1000)]);
    expect(results.filter(result => result === "account")).toHaveLength(1);
    expect((await history.items("user1", 0, 10))).toHaveLength(1);
    expect(await history.account("user1")).toEqual({next_seq: 2, items: 1, bytes: 5});
    expect(await history.put("user1", [item("over-byte-limit", Buffer.alloc(6))], {...limits, maxBytes: 4}, 1001)).toBe("account");
    expect(await history.account("user1")).toEqual({next_seq: 2, items: 1, bytes: 5});
  });
  it("serializes global quota growth across different accounts and still permits shrinking", async () => {
    const history = new PostgresHistoryStore(db), capped = {...limits, maxTotalBytes: 5};
    const results = await Promise.all([history.put("user1", [item("a")], capped, 1000), history.put("user2", [item("b")], capped, 1000)]);
    expect(results.filter(result => result === "server")).toHaveLength(1);
    const winner = results[0] === "server" ? "user2" : "user1", tag = winner === "user1" ? "a" : "b";
    expect(await history.put(winner, [item(tag, null)], {...capped, maxTotalBytes: 1}, 1001)).toEqual({seq: 2, items: 0, bytes: 0});
    expect(await history.put(winner === "user1" ? "user2" : "user1", [item("new")], capped, 1002)).toEqual({seq: 1, items: 1, bytes: 5});
  });
  it("rolls back all SQL batches and cursor totals after a failed identity constraint", async () => {
    const history = new PostgresHistoryStore(db), plan = Array.from({length: 205}, (_, n) => item(`opaque-${n}`));
    await expect(history.put("missing-owner", plan, limits, 1000)).rejects.toMatchObject({code: "23503"});
    expect(await history.items("missing-owner", 0, 1000)).toEqual([]);
    expect(await history.account("missing-owner")).toBeNull();
    expect(await history.put("user1", plan, limits, 1000)).toEqual({seq: 205, items: 205, bytes: 1025});
    const concurrent = await Promise.all([history.put("user1", [item("opaque-0")], limits, 1001), history.put("user1", [item("opaque-0")], limits, 1002)]);
    expect(concurrent.map(result => typeof result === "object" ? result.seq : result).sort()).toEqual([206, 207]);
    expect(await history.account("user1")).toEqual({next_seq: 208, items: 205, bytes: 1025});
    await expect(history.put("user1", [item("duplicate"), item("duplicate")], limits, 1000)).rejects.toThrow("deduplicated");
    expect(await history.deleteForUser("user1")).toBe(205);
    expect(await history.account("user1")).toBeNull();
    expect(await history.items("user1", 0, 1000)).toEqual([]);
  });
});

describe("PostgreSQL relationships and moderation repositories", () => {
  it("preserves unordered pair ownership, request idempotency and concurrent sent counters", async () => {
    const relationships = new PostgresRelationshipStore(db);
    const pair = {...pairOf("user2", "user1"), state: "pending" as const, requested_by: "user1", created_at: 1000, accepted_at: null};
    await relationships.putConnection(pair);
    expect(await relationships.connection("user2", "user1")).toEqual(pair);
    await relationships.putConnection({...pair, state: "accepted", accepted_at: 1100});
    expect((await relationships.connectionsOf("user1"))[0].state).toBe("accepted");
    const request = {conversation_id: "conversation1", recipient: "user2", sender: "user1", state: "pending" as const, sent: 0, created_at: 1000, answered_at: null};
    await relationships.createRequest(request);
    await relationships.createRequest({...request, sender: "user2"});
    expect(await relationships.request("conversation1")).toEqual(request);
    expect((await Promise.all(Array.from({length: 20}, () => relationships.countSent("conversation1")))).sort((a, b) => a - b)).toEqual(Array.from({length: 20}, (_, n) => n + 1));
    expect((await relationships.requestsFor("user2", "pending"))[0].sent).toBe(20);
    expect(await relationships.requestsIn([])).toEqual([]);
    expect(await relationships.requestsIn(["conversation1"])).toHaveLength(1);
    expect(await relationships.countStartedSince("user1", 1000)).toBe(2);
    expect(await relationships.countStartedSince("user1", 1001)).toBe(0);
    await relationships.declineRequest("conversation1", 1200);
    expect((await relationships.requestsFor("user2", "declined"))[0].answered_at).toBe(1200);
    await relationships.putSettings("user1", {dm_policy: "connections", request_policy: "nobody"}, 1200);
    expect(await relationships.settings("user1")).toEqual({dm_policy: "connections", request_policy: "nobody"});
    expect(await relationships.settings("user2")).toBeNull();
    await relationships.deleteForUser("user1");
    expect(await relationships.connection("user1", "user2")).toBeNull();
    expect(await relationships.request("conversation1")).toBeNull();
    expect(await relationships.settings("user1")).toBeNull();
  });
  it("rejects invalid relationship state and preserves transaction rollback", async () => {
    const relationships = new PostgresRelationshipStore(db);
    const pair = {...pairOf("user1", "user2"), state: "pending" as const, requested_by: "user1", created_at: 1000, accepted_at: null};
    await expect(relationships.putConnection({...pair, pair: "forged"})).rejects.toThrow("connection pair");
    await expect(db.transaction(async () => {
      await relationships.putConnection(pair);
      await relationships.putSettings("user1", {dm_policy: "forged" as "everyone", request_policy: "nobody"}, 1000);
    })).rejects.toMatchObject({code: "23514"});
    expect(await relationships.connectionsOf("user1")).toEqual([]);
    expect(await relationships.deleteConnection("user1", "user2")).toBe(false);
    expect(await relationships.countSent("missing")).toBe(0);
  });
  const report = (id: string, overrides: Partial<ReportRow> = {}): ReportRow => ({id, org_id: null, reporter_id: "user1", target_user_id: "user2",
    conversation_id: "conversation1", message_id: "synthetic-message", reason: "spam", note: null, content: "sealed-ciphertext-fixture", status: "open",
    handled_by: null, handled_note: null, created_at: 1000, handled_at: null, ...overrides});
  it("preserves sealed reports, operator queues, tie pagination and reopen/retention behavior", async () => {
    const reports = new PostgresReportStore(db);
    await reports.create(report("report-a"));
    await reports.create(report("report-b"));
    expect(await new PostgresReportStore(db).get("report-a")).toEqual(report("report-a"));
    expect(await reports.byReporterMessage("user1", "synthetic-message")).not.toBeNull();
    expect(await reports.countSince("user1", 1000)).toBe(2);
    expect(await reports.countOpen(null)).toBe(2);
    expect((await reports.list(null, false, 10)).map(row => row.id)).toEqual(["report-b", "report-a"]);
    const page = await reports.adminList({status: "open", targetUserId: "user2", q: "spam", limit: 1});
    expect(page.map(row => row.id)).toEqual(["report-b"]);
    expect((await reports.adminList({after: {createdAt: 1000, id: "report-b"}, limit: 10})).map(row => row.id)).toEqual(["report-a"]);
    expect(await reports.adminList({q: "' OR 1=1 --", limit: 10})).toEqual([]);
    expect((await reports.setStatus("report-b", "actioned", "user1", "reviewed", 2000))?.handled_by).toBe("user1");
    expect(await reports.countOpen(null)).toBe(1);
    expect((await reports.list(null, true, 10)).map(row => row.id)).toEqual(["report-b"]);
    expect(await reports.purgeClosed(2000)).toBe(0);
    expect((await reports.setStatus("report-b", "open", "user1", "ignored", 2100))?.handled_at).toBeNull();
    expect(await reports.purgeClosed(3000)).toBe(0);
    await reports.setStatus("report-a", "dismissed", "user1", null, 2000);
    expect(await reports.purgeClosed(2001)).toBe(1);
    expect(await reports.get("report-a")).toBeNull();
    expect(await reports.deleteForUser("user2")).toBe(1);
    expect(await reports.setStatus("missing", "actioned", "user1", null, 2000)).toBeNull();
  });
});

describe("PostgreSQL recovery and sealed key material", () => {
  it("replaces an entire recovery set atomically and permits only one use of each hash", async () => {
    const recovery = new PostgresRecoveryStore(db);
    const code = (id: string) => ({id, account_id: "account1", code_hash: `synthetic-hash-${id}`, created_at: 1000, used_at: null});
    await recovery.replaceCodes("account1", [code("old")]);
    await expect(recovery.replaceCodes("account1", [code("duplicate"), code("duplicate")])).rejects.toMatchObject({code: "23505"});
    expect(await recovery.codes("account1")).toEqual([code("old")]);
    const won = await Promise.all([recovery.useCode("account1", code("old").code_hash, 1100), recovery.useCode("account1", code("old").code_hash, 1100)]);
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(await recovery.useCode("account2", code("old").code_hash, 1100)).toBe(false);
    await Promise.all([recovery.replaceCodes("account1", [code("generation-a1"), code("generation-a2")]), recovery.replaceCodes("account1", [code("generation-b1"), code("generation-b2")])]);
    const ids = (await recovery.codes("account1")).map(row => row.id);
    expect(ids.length).toBe(2);
    expect(ids.every(id => id.startsWith("generation-a")) || ids.every(id => id.startsWith("generation-b"))).toBe(true);
    expect(await recovery.deleteCodes("account1")).toBe(2);
  });
  it("enforces one-use ticket expiry and preserves the audit retention grace", async () => {
    const recovery = new PostgresRecoveryStore(db);
    const ticket = {ticket_hash: "synthetic-ticket", account_id: "account1", new_email: "fixture@example.invalid", email_code_hash: "synthetic-email-code-hash",
      attempts: 0, created_at: 1000, expires_at: 2000, used_at: null};
    await recovery.insertTicket(ticket);
    await Promise.all(Array.from({length: 10}, () => recovery.countTicketAttempt(ticket.ticket_hash)));
    expect((await new PostgresRecoveryStore(db).ticket(ticket.ticket_hash))?.attempts).toBe(10);
    expect(await recovery.useTicket(ticket.ticket_hash, 2000)).toBe(false);
    expect((await Promise.all([recovery.useTicket(ticket.ticket_hash, 1999), recovery.useTicket(ticket.ticket_hash, 1999)])).filter(Boolean)).toHaveLength(1);
    expect(await recovery.purgeExpired(RECOVERY_TICKET_GRACE_MS + 1999)).toBe(0);
    expect(await recovery.purgeExpired(RECOVERY_TICKET_GRACE_MS + 2000)).toBe(1);
    expect(await recovery.ticket(ticket.ticket_hash)).toBeUndefined();
  });
  it("copies sealed backups exactly, retains original creation time and atomically consumes unlocks", async () => {
    const keys = new PostgresKeyBackupStore(db);
    const backup = {account_id: "account1", identity_key: "synthetic-identity", password_changed_at: 1000, version: 1, iterations: 600000,
      salt: "sealed-salt", nonce: "sealed-nonce", ciphertext: "opaque-ciphertext", created_at: 1000, updated_at: 1000};
    await keys.putBackup(backup);
    expect(await new PostgresKeyBackupStore(db).backup("account1")).toEqual(backup);
    await keys.putBackup({...backup, ciphertext: "replacement-ciphertext", created_at: 2000, updated_at: 2000});
    expect(await keys.backup("account1")).toEqual({...backup, ciphertext: "replacement-ciphertext", updated_at: 2000});
    await keys.putUnlock({account_id: "account1", session_id: "synthetic-session", code_hash: "hash1", attempts: 0, created_at: 1000, expires_at: 2000});
    await keys.countUnlockAttempt("account1");
    expect((await keys.unlock("account1"))?.attempts).toBe(1);
    await keys.putUnlock({account_id: "account1", session_id: "new-session", code_hash: "hash2", attempts: 99, created_at: 1100, expires_at: 2100});
    expect((await keys.unlock("account1"))?.attempts).toBe(0);
    expect(await keys.useUnlock("account1", "hash1")).toBe(false);
    expect((await Promise.all([keys.useUnlock("account1", "hash2"), keys.useUnlock("account1", "hash2")])).filter(Boolean)).toHaveLength(1);
    expect(await keys.backup("account2")).toBeUndefined();
    await keys.putUnlock({account_id: "account1", session_id: "synthetic-session", code_hash: "hash3", attempts: 0, created_at: 1000, expires_at: 2000});
    expect(await keys.purgeExpired(1999)).toBe(0);
    expect(await keys.purgeExpired(2000)).toBe(1);
    await keys.deleteForAccount("account1");
    expect(await keys.backup("account1")).toBeUndefined();
    expect(await keys.deleteBackup("account1")).toBe(false);
  });
});

describe("PostgreSQL account and identity transactions", () => {
  const sessionRow = (id: string, accountId = "account1"): SessionRow => ({id, account_id: accountId, device_id: null, label: "Synthetic test",
    access_hash: `access-${id}`, access_expires_at: 5000, refresh_hash: `refresh-${id}`, previous_refresh_hash: null, previous_refresh_answer: null,
    refresh_expires_at: 10000, expires_at: 10000, created_at: 1000, refreshed_at: 1000, last_used_at: 1000, revoked_at: null, revoke_reason: null});
  const accountRow = (id: string): AccountRow => ({id, email: `${id}@example.invalid`, name: id, password_hash: "!synthetic", password_changed_at: 1000,
    email_verified_at: null, user_id: null, legacy_linked_at: null, selected_workspace_id: null, admitted_via: null, created_at: 1000, updated_at: 1000, disabled_at: null});
  it("isolates staged changes across awaits and rolls them back before a competing writer proceeds", async () => {
    const rows = await PostgresRows.open(db, tableSpecs()), accounts = new PostgresAccountStore(rows);
    let start!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const transaction = accounts.transaction(async () => {
        await accounts.updateAccount("account1", {name: "uncommitted"}, 2000);
        expect((await accounts.accountById("account1"))?.name).toBe("uncommitted");
        start(); await gate;
        throw new Error("abort account transaction");
      });
      const failed = expect(transaction).rejects.toThrow("abort account transaction");
      await started;
      expect((await accounts.accountById("account1"))?.name).toBe("account1");
      expect((await db.query("SELECT name FROM meldiq.accounts WHERE id='account1'")).rows[0].name).toBe("account1");
      let competingDone = false;
      const competing = accounts.updateAccount("account1", {name: "committed competitor"}, 2001).then(() => { competingDone = true; });
      await Promise.resolve(); expect(competingDone).toBe(false);
      release(); await failed; await competing;
      expect((await accounts.accountById("account1"))?.name).toBe("committed competitor");
      expect((await db.query("SELECT name FROM meldiq.accounts WHERE id='account1'")).rows[0].name).toBe("committed competitor");
    } finally { release(); await rows.close(); }
  });
  it("discards both account and identity overlays after a real PostgreSQL constraint failure", async () => {
    const rows = await PostgresRows.open(db, tableSpecs()), accounts = new PostgresAccountStore(rows);
    try {
      await expect(accounts.transaction(async () => {
        await accounts.updateAccount("account1", {name: "must roll back"}, 2000);
        await rows.write(writer => writer.update("users", {id: "user1"}, {kind: "invalid-kind"}));
      })).rejects.toMatchObject({code: "23514"});
      expect((await accounts.accountById("account1"))?.name).toBe("account1");
      expect(rows.get<{kind: string}>("users", {id: "user1"})?.kind).toBe("person");
      expect((await db.query("SELECT name FROM meldiq.accounts WHERE id='account1'")).rows[0].name).toBe("account1");
      await accounts.transaction(async () => {
        await accounts.updateAccount("account1", {name: "outer"}, 2000);
        await expect(accounts.transaction(async () => {
          await accounts.updateAccount("account1", {name: "inner rollback"}, 2001);
          throw new Error("nested abort");
        })).rejects.toThrow("nested abort");
        expect((await accounts.accountById("account1"))?.name).toBe("outer");
      });
      expect((await accounts.accountById("account1"))?.name).toBe("outer");
    } finally { await rows.close(); }
  });
  it("consumes an invite and creates its account together, retaining the invite on a duplicate email", async () => {
    await db.query("INSERT INTO meldiq.registration_invites(id,code_hash,code_hint,note,max_uses,uses,created_at,expires_at,revoked_at,purpose) VALUES('invite','hash','hint','Synthetic',1,0,1000,5000,NULL,'account')");
    const rows = await PostgresRows.open(db, tableSpecs()), accounts = new PostgresAccountStore(rows);
    const admission = {take: (writer: import("../src/infrastructure/database/rows/types.js").RowWriter) => {
      const invite = writer.get<{uses: number}>("registration_invites", {id: "invite"})!;
      if (invite.uses >= 1) throw new Error("Invite already used");
      writer.update("registration_invites", {id: "invite"}, {uses: invite.uses + 1}); return "invite";
    }, undo: () => { throw new Error("Compensation must never be needed"); }};
    try {
      expect(await accounts.createAccount({...accountRow("duplicate"), email: "FIXTURE1@example.invalid"}, admission)).toBeNull();
      expect((await db.query("SELECT uses FROM meldiq.registration_invites WHERE id='invite'")).rows[0].uses).toBe(0);
      expect((await accounts.createAccount(accountRow("fresh"), admission))?.admitted_via).toBe("invite");
      expect((await db.query("SELECT uses FROM meldiq.registration_invites WHERE id='invite'")).rows[0].uses).toBe(1);
      expect((await accounts.accountByEmail("FRESH@example.invalid"))?.id).toBe("fresh");
      expect(await accounts.changeVerifiedEmail("fresh", "fixture1@example.invalid", 2000)).toBe(false);
      expect((await accounts.accountById("fresh"))?.email).toBe("fresh@example.invalid");
    } finally { await rows.close(); }
  });
  it("atomically creates encryption identity, device and session binding with strict ownership", async () => {
    const rows = await PostgresRows.open(db, tableSpecs()), accounts = new PostgresAccountStore(rows);
    try {
      await accounts.insertAccount(accountRow("enroll"));
      await accounts.insertSession(sessionRow("enroll-session", "enroll"));
      const create = (writer: import("../src/infrastructure/database/rows/types.js").RowWriter) => {
        writer.insert("users", {id: "new-user", username: "new-user", display_name: "Synthetic", identity_key: "new-identity-key", created_at: 1000, updated_at: 1000});
        writer.insert("devices", {id: "new-device", user_id: "new-user", name: "Synthetic", signing_key: "signature-key", encryption_key: "encryption-key", certificate: "certificate", created_at: 1000, last_seen_at: 1000});
        return "new-device";
      };
      expect(await accounts.linkIdentity("enroll", "new-user", "enroll-session", 2000, create)).toBe("new-device");
      expect((await accounts.sessionById("enroll-session"))?.device_id).toBe("new-device");
      expect((await accounts.accountById("enroll"))?.user_id).toBe("new-user");
      expect(await accounts.linkIdentity("enroll", "another-user", "enroll-session", 2001, () => { throw new Error("Already linked"); })).toBeNull();
      await expect(accounts.bindDeviceWith("enroll-session", writer => {
        writer.insert("devices", {id: "forged-device", user_id: "user2", name: "Wrong owner", signing_key: "bad", encryption_key: "bad", certificate: "bad", created_at: 1000, last_seen_at: 1000});
        return "forged-device";
      })).rejects.toThrow("ownership mismatch");
      expect(rows.get("devices", {id: "forged-device"})).toBeUndefined();
      expect((await db.query("SELECT user_id FROM meldiq.accounts WHERE id='enroll'")).rows[0].user_id).toBe("new-user");
      await rows.close();
      const reopened = await PostgresRows.open(db, tableSpecs());
      try { expect((await new PostgresAccountStore(reopened).sessionById("enroll-session"))?.device_id).toBe("new-device"); }
      finally { await reopened.close(); }
    } finally { await rows.close(); }
  });
  it("preserves refresh CAS, one-use codes, factor metadata and account revocation", async () => {
    const rows = await PostgresRows.open(db, tableSpecs()), accounts = new PostgresAccountStore(rows);
    try {
      const session = sessionRow("test-session");
      await accounts.insertSession({...session, second_factor_at: 1000});
      expect((await accounts.sessionByAccessHash(session.access_hash))?.second_factor_at).toBe(1000);
      const rotation = {access_hash: "rotated-access", access_expires_at: 6000, refresh_hash: "rotated-refresh", previous_refresh_hash: session.refresh_hash,
        previous_refresh_answer: "sealed-refresh-answer", refresh_expires_at: 11000, refreshed_at: 2000, last_used_at: 2000};
      expect((await Promise.all([accounts.rotateSession(session.id, rotation, session.refresh_hash), accounts.rotateSession(session.id, rotation, session.refresh_hash)])).filter(Boolean)).toHaveLength(1);
      expect(await accounts.sessionHolders(2000)).toBe(1);
      expect(await accounts.activeSessions("account1", 2000)).toHaveLength(1);
      await accounts.putCode({account_id: "account1", purpose: "verify_email", code_hash: "synthetic-code-hash", attempts: 99, created_at: 1000, expires_at: 3000});
      await accounts.countCodeAttempt("account1", "verify_email");
      expect((await accounts.code("account1", "verify_email"))?.attempts).toBe(1);
      expect((await Promise.all([accounts.deleteCode("account1", "verify_email", "synthetic-code-hash"), accounts.deleteCode("account1", "verify_email", "synthetic-code-hash")])).filter(Boolean)).toHaveLength(1);
      expect(await accounts.revokeSession(session.id, "test", 2500)).toBe(true);
      expect(await accounts.revokeSession(session.id, "duplicate", 2600)).toBe(false);
      expect(await accounts.activeSessions("account1", 2500)).toEqual([]);
      expect(await accounts.recentSessions("account1", 2000, 10)).toHaveLength(1);
      expect(await accounts.sessionHolders(2500)).toBe(0);
    } finally { await rows.close(); }
  });
  it("uses exact provider/issuer/subject ownership and never links by matching email", async () => {
    const rows = await PostgresRows.open(db, tableSpecs()), accounts = new PostgresAccountStore(rows);
    const social = new SocialStore({identity: rows, accounts: {store: accounts}} as unknown as AppContext);
    const identity = {id: "provider-identity", account_id: "account1", provider: "google" as const, issuer: "https://accounts.google.com", subject: "verified-subject", email: "fixture1@example.invalid", connected_at: 1000};
    try {
      await social.link(identity);
      expect(await social.find(identity)).toEqual(identity);
      expect(await social.find({...identity, subject: "other-subject"})).toBeNull();
      expect(await social.find({...identity, issuer: "https://untrusted.example.invalid"})).toBeNull();
      await expect(social.link({...identity, id: "duplicate-identity", account_id: "account2"})).rejects.toMatchObject({statusCode: 409, code: "identity_conflict"});
      expect(await social.list("account2")).toEqual([]);
      expect(await social.list("account1")).toEqual([identity]);
      await social.unlink("account1", "google");
      expect(await social.find(identity)).toBeNull();
    } finally { await rows.close(); }
  });
  it("consumes social receipts in the same account transaction and restores them after a later failure", async () => {
    const rows = await PostgresRows.open(db, tableSpecs()), accounts = new PostgresAccountStore(rows);
    const social = new SocialStore({identity: rows, accounts: {store: accounts}} as unknown as AppContext);
    const flow: SocialFlow = {id: "social-flow", provider: "google", challenge: "synthetic-challenge", verifier: "synthetic-verifier", cookie: "synthetic-cookie",
      accountId: null, sessionId: null, platform: "web", nonce: "synthetic-nonce", stage: "ready", expiresAt: Date.now() + 10000};
    try {
      await social.insertFlow(flow);
      await expect(accounts.transaction(async () => {
        expect(await social.replace({...flow, stage: "used"}, "ready")).toBe(true);
        await accounts.updateAccount("account1", {name: "failed provider mutation"}, 2000);
        throw new Error("provider link failed");
      })).rejects.toThrow("provider link failed");
      expect((await social.flow(flow.id))?.stage).toBe("ready");
      expect((await accounts.accountById("account1"))?.name).toBe("account1");
      expect((await Promise.all([social.replace({...flow, stage: "used"}, "ready"), social.replace({...flow, stage: "used"}, "ready")])).filter(Boolean)).toHaveLength(1);
      expect((await social.flow(flow.id))?.stage).toBe("used");
    } finally { await rows.close(); }
  });
});

describe("PostgreSQL legacy delivery and call metadata", () => {
  const submission = (id: string): Submission => ({message_id: id, sender_device_id: "device1", sender_user_id: "user1", conversation_id: "conversation1", recipient_count: 1, server_ts: 1000, expires_at: 5000});
  const queued = (id: string, recipient = "device2"): QueueInsert => ({recipient_device_id: recipient, kind: "envelope", conversation_id: "conversation1", message_id: id,
    sender_user_id: "user1", sender_device_id: "device1", payload: "opaque-encrypted-envelope", created_at: 1000, expires_at: 5000});
  it("commits submission and per-device delivery once, fences acknowledgments and resumes counters after restart", async () => {
    const rows = await PostgresRows.open(db, tableSpecs()), relay = new PostgresRelayStore(rows);
    let lastId = 0;
    try {
      const results = await Promise.allSettled([relay.accept(submission("message1"), [queued("message1")]), relay.accept(submission("message1"), [queued("message1")])]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
      expect(await relay.enqueue([queued("message1")])).toEqual([]);
      const backlog = await relay.backlog("device2", 4999, 10);
      expect(backlog).toHaveLength(1); lastId = backlog[0].id;
      expect(Number.isSafeInteger(lastId)).toBe(true);
      expect(await relay.backlog("device2", 5000, 10)).toEqual([]);
      expect(await relay.hasEnvelopeSince("device2", 1000, 4999)).toBe(true);
      expect(await relay.hasEnvelopeSince("device2", 1001, 4999)).toBe(false);
      expect(await relay.take("other-device", [lastId])).toEqual([]);
      expect(await relay.take("device2", [lastId, lastId])).toEqual(backlog);
      expect(await relay.stats()).toEqual({envelopes: 0, receipts: 0, oldestCreatedAt: null});
      expect(await relay.countInConversations([])).toBe(0);
    } finally { await rows.close(); }
    const reopened = await PostgresRows.open(db, tableSpecs());
    try {
      const restarted = new PostgresRelayStore(reopened);
      expect(await restarted.submission("message1")).toEqual(submission("message1"));
      const next = await restarted.enqueue([queued("message2")]);
      expect(next[0].id).toBeGreaterThan(lastId);
      restarted.forgetConversationFor("conversation1", ["device2"]); await restarted.settled();
      expect(await restarted.backlog("device2", 1000, 10)).toEqual([]);
      restarted.forgetSender("user1"); await restarted.settled();
      expect(await restarted.submission("message1")).toBeNull();
    } finally { await reopened.close(); }
  });
  it("rolls back a rejected queue row with its submission and retains atomic identity cascades", async () => {
    const rows = await PostgresRows.open(db, tableSpecs()), relay = new PostgresRelayStore(rows);
    try {
      await expect(relay.accept(submission("invalid"), [{...queued("invalid"), kind: "invalid" as "envelope"}])).rejects.toMatchObject({code: "23514"});
      expect(await relay.submission("invalid")).toBeNull();
      expect(await relay.backlog("device2", 1000, 10)).toEqual([]);
      await relay.accept(submission("valid"), [queued("valid")]);
      await expect(rows.transaction(async () => {
        relay.forgetConversation("conversation1");
        throw new Error("abort conversation deletion");
      })).rejects.toThrow("abort conversation deletion");
      await relay.settled();
      expect(await relay.submission("valid")).not.toBeNull();
      expect(await relay.purgeExpired(5000)).toEqual({queue: 1, submitted: 1});
    } finally { await rows.close(); }
  });
  const call = (id: string): CallRow => ({id, conversation_id: "conversation1", room_name: `room-${id}`, created_by: "user1", video: 1, state: "RINGING",
    created_at: 0, answered_at: null, ended_at: null, end_reason: null, alerted_at: null, host_server_id: null});
  it("preserves answer/alert races, newest-device movement, hand order, attendance and retention", async () => {
    const calls = new PostgresCallStore(db);
    await calls.insert(call("call1"));
    expect((await calls.byRoom("room-call1"))?.id).toBe("call1");
    expect((await Promise.all([calls.markAnswered("call1", 60000), calls.markAnswered("call1", 60001)])).filter(Boolean)).toHaveLength(1);
    expect((await Promise.all([calls.markAlerted("call1", 30000), calls.markAlerted("call1", 30001)])).filter(Boolean)).toHaveLength(1);
    await calls.join("call1", "user1", "old-device", 0, false);
    await calls.join("call1", "user1", "new-device", 60000, false);
    await calls.join("call1", "user2", "other-user-device", 60000, false);
    expect(await calls.leaveOtherDevices("call1", "user1", "new-device", 120000)).toEqual(["old-device"]);
    await calls.join("call1", "user1", "old-device", 150000, false);
    expect((await calls.participants("call1")).find(row => row.device_id === "old-device")?.joined_at).toBe(0);
    expect(await calls.leave("call1", "old-device", 180000)).toBe(true);
    expect(await calls.leave("call1", "old-device", 180001)).toBe(false);
    await calls.join("call1", "user1", "new-device", 180000, true);
    await calls.raiseHand("call1", "user1", 60000); await calls.raiseHand("call1", "user2", 70000); await calls.raiseHand("call1", "user1", 90000);
    expect(await calls.hands("call1")).toEqual([{user_id: "user1", raised_at: 60000}, {user_id: "user2", raised_at: 70000}]);
    expect(await calls.activeCounts()).toEqual({calls: 1, video: 1, participants: 2});
    expect(await calls.liveWithParticipant("user1")).toHaveLength(1);
    expect(await calls.liveIn([])).toEqual([]);
    expect(await calls.countIn(["conversation1"])).toBe(1);
    expect((await Promise.all([calls.end("call1", 240000, "lost"), calls.end("call1", 240000, "lost")])).filter(Boolean)).toHaveLength(1);
    expect(await calls.present("call1")).toEqual([]);
    expect(await calls.participantMinutes(["conversation1"], 0, 300000, 300000)).toBe(7);
    expect(await calls.participantMinutes(["conversation1"], 60000, 180000, 300000)).toBe(4);
    expect(await calls.days(0)).toEqual([{day: "1970-01-01", started: 1, answered: 1, declined: 0, lost: 1}]);
    expect(await calls.leaderboardSpans(["conversation1"], 180000)).toHaveLength(2);
    expect(await calls.history("conversation1", 0, 1, 10)).toHaveLength(1);
    await calls.lowerHand("call1", "user1"); await calls.forgetUserHands("user2");
    expect(await calls.hands("call1")).toEqual([]);
    expect(await calls.pruneEnded(239999)).toBe(0);
    expect(await calls.pruneEnded(240000)).toBe(1);
    expect(await calls.participants("call1")).toEqual([]);
  });
  it("keeps mirrored-call updates transactional and refuses to revive an ended room", async () => {
    const calls = new PostgresCallStore(db), mirror = {...call("mirror"), host_server_id: "remote-server"};
    await calls.applyMirror(mirror, [{user_id: "user2", device_id: "remote-device", joined_at: 1000}]);
    expect(await calls.live(false)).toHaveLength(1);
    expect(await calls.live(true)).toEqual([]);
    await calls.end(mirror.id, 2000, "ended");
    await calls.applyMirror({...mirror, state: "ACTIVE", answered_at: 1500}, []);
    expect((await calls.get(mirror.id))?.state).toBe("ENDED");
    await expect(calls.applyMirror({...call("invalid-mirror"), created_by: "missing-user"}, [])).rejects.toMatchObject({code: "23503"});
    expect(await calls.get("invalid-mirror")).toBeNull();
    await calls.forgetConversations(["conversation1"]);
    expect(await calls.get(mirror.id)).toBeNull();
  });
});

describe("PostgreSQL privacy and catalog favorites", () => {
  it("preserves privacy choices across restart, isolates owners and enforces the released policy enum", async () => {
    const privacy = new PostgresPrivacyStore(db);
    expect(await privacy.get("user1")).toBeNull();
    await privacy.put("user1", {groupAddPolicy: "friends", suggestable: false}, 1000);
    expect(await new PostgresPrivacyStore(db).get("user1")).toEqual({groupAddPolicy: "friends", suggestable: false});
    expect(await privacy.get("user2")).toBeNull();
    expect(await privacy.many([])).toEqual(new Map());
    expect(await privacy.many(["user1", "user2"])).toEqual(new Map([["user1", {groupAddPolicy: "friends", suggestable: false}]]));
    await expect(privacy.put("user1", {groupAddPolicy: "invalid" as "everyone", suggestable: true}, 2000)).rejects.toMatchObject({code: "23514"});
    expect(await privacy.get("user1")).toEqual({groupAddPolicy: "friends", suggestable: false});
    await privacy.deleteForUser("user1");
    expect(await privacy.get("user1")).toBeNull();
  });
  it("accepts built-in favorites, keeps uploaded favorites after removal and isolates user lists", async () => {
    const favorites = new PostgresFavoriteStore(db);
    expect((await Promise.all([favorites.add("user1", "builtin:star", 1000), favorites.add("user1", "builtin:star", 1000)])).filter(Boolean)).toHaveLength(1);
    await db.query(`INSERT INTO meldiq.profile_decorations(id,creator_id,name,status,format,size,created_at,wearers,reviewed_by,reason,reviewed_at,animated)
      VALUES('uploaded-decoration','user1','Synthetic','approved','png',1,1000,0,NULL,NULL,NULL,false)`);
    expect(await favorites.add("user1", "uploaded-decoration", 2000)).toBe(true);
    await db.query("DELETE FROM meldiq.profile_decorations WHERE id='uploaded-decoration'");
    expect(await new PostgresFavoriteStore(db).list("user1")).toEqual(["uploaded-decoration", "builtin:star"]);
    expect(await favorites.count("user1")).toBe(2);
    await favorites.add("user2", "builtin:star", 2000);
    await favorites.remove("user1", "builtin:star");
    expect(await favorites.list("user1")).toEqual(["uploaded-decoration"]);
    expect(await favorites.list("user2")).toEqual(["builtin:star"]);
    await favorites.deleteForUser("user1");
    expect(await favorites.count("user1")).toBe(0);
    expect(await favorites.count("user2")).toBe(1);
  });
});

describe("PostgreSQL Meldiq OAuth apps and durable replay revocation", () => {
  const app: OAuthApp = {id: "oauth-app", ownerId: "user1", name: "Synthetic app", redirectUris: ["https://client.example.invalid/callback"],
    secretHash: secretHash("synthetic-client-secret"), createdAt: 1000, updatedAt: 1000, secretRotatedAt: 1000};
  async function setup() {
    const store = new PostgresOAuthStore(db);
    await store.insertApp(app);
    await store.upsertGrant(app.id, "user1", ["identify"], 1000);
    await store.insertCode({hash: secretHash("synthetic-code"), appId: app.id, userId: "user1", redirectUri: app.redirectUris[0], scopes: ["identify"], challenge: null,
      createdAt: 1000, expiresAt: 10000, usedAt: null, familyId: null});
    const service = new OAuthService({} as AppContext, store, () => 2000);
    const body = {grant_type: "authorization_code" as const, code: "synthetic-code", redirect_uri: app.redirectUris[0]};
    const credentials = {id: app.id, secret: "synthetic-client-secret"};
    return {store, service, body, credentials};
  }
  it("merges concurrent scope approvals, protects ownership and atomically revokes a grant's material", async () => {
    const {store} = await setup();
    await Promise.all([store.upsertGrant(app.id, "user1", ["identify"], 2000), store.upsertGrant(app.id, "user1", ["email"], 2000)]);
    expect(new Set((await store.grant(app.id, "user1"))?.scopes)).toEqual(new Set(["identify", "email"]));
    expect(await store.updateApp(app.id, "user2", {name: "forged owner"}, 2000)).toBeNull();
    expect((await store.app(app.id))?.name).toBe(app.name);
    expect(await store.appsOf("user1")).toHaveLength(1);
    expect(await store.appsByIds([])).toEqual([]);
    expect(await store.grantsOf("user1")).toHaveLength(1);
    expect(await store.revokeGrant(app.id, "user1")).toBe(true);
    expect(await store.grant(app.id, "user1")).toBeNull();
    expect(await store.takeCode(secretHash("synthetic-code"), 2000)).toBeNull();
    expect(await store.revokeGrant(app.id, "user1")).toBe(false);
  });
  it("issues once and commits family revocation when a concurrent code replay is rejected", async () => {
    const {store, service, body, credentials} = await setup();
    const results = await Promise.allSettled([oauthToken(service, body, credentials), oauthToken(service, body, credentials)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({error: "invalid_grant"});
    expect((await db.query("SELECT count(*) AS count FROM meldiq.oauth_tokens")).rows[0].count).toBe(0);
    const code = await store.takeCode(secretHash("synthetic-code"), 3000);
    expect(code?.usedAt).toBe(2000);
    expect(Boolean(code?.familyId)).toBe(true);
  });
  it("rotates once and commits revocation when a replaced refresh token is replayed", async () => {
    const {store, service, body, credentials} = await setup();
    const issued = await oauthToken(service, body, credentials);
    const family = await store.familyByAccess(secretHash(issued.access_token));
    expect(Boolean(family)).toBe(true);
    const refresh = {grant_type: "refresh_token" as const, refresh_token: issued.refresh_token};
    const results = await Promise.allSettled([oauthToken(service, refresh, credentials), oauthToken(service, refresh, credentials)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await store.family(family!.id)).toBeNull();
  });
  it("rolls code consumption back on an unexpected persistence failure", async () => {
    const {store} = await setup();
    await expect(store.transaction(async () => {
      await store.takeCode(secretHash("synthetic-code"), 2000);
      await store.insertFamily({id: "invalid-family", appId: app.id, userId: "missing-owner", scopes: ["identify"], confidential: true,
        accessHash: "synthetic-access-hash", accessExpiresAt: 5000, refreshHash: "synthetic-refresh-hash", previousRefreshHash: null,
        refreshExpiresAt: 10000, createdAt: 2000, rotatedAt: 2000});
    })).rejects.toMatchObject({code: "23503"});
    expect((await store.takeCode(secretHash("synthetic-code"), 3000))?.usedAt).toBeNull();
    expect(await store.family("invalid-family")).toBeNull();
  });
});

describe("PostgreSQL bots and community configuration", () => {
  async function org() {
    await db.query("INSERT INTO meldiq.orgs(id,name,slug,created_by,created_at,updated_at) VALUES('org1','Synthetic','synthetic','user1',1000,1000)");
  }
  it("claims bot interactions without duplicate delivery and preserves reply/expiry outcomes", async () => {
    await org();
    const bots = new PostgresBotStore(db);
    const bot = {id: "user2", ownerId: "user1", tokenHash: "synthetic-bot-token-hash", public: false, commands: [], createdAt: 1000, tokenRotatedAt: 1000};
    await bots.insertBot(bot);
    expect(await new PostgresBotStore(db).botByToken(bot.tokenHash)).toEqual(bot);
    expect(await bots.botsOf("user1")).toEqual([bot]);
    expect(await bots.botsByIds([])).toEqual([]);
    expect((await bots.updateBot(bot.id, {public: true}))?.public).toBe(true);
    for (let n = 1; n <= 2; n++) await bots.addInteraction({id: `interaction${n}`, botId: bot.id, userId: "user1", orgId: "org1", conversationId: "conversation1",
      command: "synthetic", options: {choice: true}, state: "pending", createdAt: 1000 + n, expiresAt: 3000, deliveredAt: null, repliedAt: null});
    expect(await bots.openCount(bot.id, 2000)).toBe(2);
    const claimed = (await Promise.all([bots.claim(bot.id, 2000, 1000, 1), bots.claim(bot.id, 2000, 1000, 1)])).flat();
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map(item => item.id)).size).toBe(2);
    expect(await bots.claim(bot.id, 2100, 1999, 10)).toEqual([]);
    expect(await bots.claim(bot.id, 2200, 2000, 10)).toHaveLength(2);
    expect(await bots.answer("interaction1", "user1", 2300)).toBe("missing");
    expect((await Promise.all([bots.answer("interaction1", bot.id, 2300), bots.answer("interaction1", bot.id, 2300)])).sort()).toEqual(["answered", "ok"]);
    await bots.reopen("interaction1");
    expect((await bots.interaction("interaction1"))?.repliedAt).toBeNull();
    expect(await bots.answer("interaction1", bot.id, 2400)).toBe("ok");
    expect(await bots.answer("interaction2", bot.id, 3000)).toBe("expired");
    expect(await bots.openCount(bot.id, 3000)).toBe(0);
    expect(await bots.purgeExpired(3000)).toBe(2);
    await bots.deleteBot(bot.id);
    expect(await bots.bot(bot.id)).toBeNull();
  });
  it("retains community rules, pins and awards when a historical moderator is purged", async () => {
    await org();
    await db.query("INSERT INTO meldiq.users(id,username,display_name,identity_key,avatar_color,created_at,updated_at) VALUES('former-moderator','former-moderator','Synthetic','synthetic',1,1000,1000)");
    const rules = new PostgresRulesStore(db), pins = new PostgresPinStore(db);
    const document = {orgId: "org1", channelId: null, required: true, rules: [{id: "rule1", title: "Be kind", description: null}], updatedAt: 1000, updatedBy: "former-moderator"};
    const pin = {id: "pin1", orgId: "org1", name: "Synthetic", description: null, format: "png" as const, animated: false, createdBy: "former-moderator", createdAt: 1000};
    const award = {pinId: pin.id, orgId: "org1", userId: "user2", awardedBy: "former-moderator", awardedAt: 1000};
    await rules.put(document); await pins.insertPin(pin);
    expect((await Promise.all([pins.award(award), pins.award({...award, awardedAt: 2000})])).filter(Boolean)).toHaveLength(1);
    expect((await Promise.all([rules.agree({orgId: "org1", userId: "user2", agreedAt: 1000}), rules.agree({orgId: "org1", userId: "user2", agreedAt: 1000})])).filter(Boolean)).toHaveLength(1);
    await db.query("DELETE FROM meldiq.users WHERE id='former-moderator'");
    expect(await new PostgresRulesStore(db).all()).toEqual([document]);
    expect(await new PostgresPinStore(db).pins()).toEqual([pin]);
    expect((await pins.awards())[0].awardedBy).toBe("former-moderator");
    expect(await rules.agreements()).toHaveLength(1);
    await rules.forget("org1", "user2"); expect(await rules.agreements()).toEqual([]);
    await rules.agree({orgId: "org1", userId: "user2", agreedAt: 2000});
    await rules.deleteForUser("user2"); expect(await rules.agreements()).toEqual([]);
    expect(await pins.revoke(pin.id, "user2")).toBe(true);
    expect(await pins.revoke(pin.id, "user2")).toBe(false);
    await pins.award(award); await pins.removePin(pin.id);
    expect(await pins.awards()).toEqual([]);
    expect(await rules.all()).toEqual([document]);
    await rules.removeOrg("org1"); expect(await rules.all()).toEqual([]);
  });
});

describe("PostgreSQL server-earned points and decoration moderation", () => {
  const earned = (id: string, amount = 40): PointsEntry => ({id, userId: "user1", kind: "chat", amount, detail: null, day: "2026-11-02", at: 1000});
  const levelEntry = (level: number): PointsEntry => ({...earned(`level-${level}`, -30), kind: "level", detail: String(level), at: 2000});
  it("commits idempotent earnings and one covered level debit with exact account/day/ledger totals", async () => {
    const points = new PostgresPointsStore(db);
    expect((await Promise.all([points.earn(earned("earning")), points.earn(earned("earning"))])).filter(Boolean)).toHaveLength(1);
    expect(await points.earn(earned("earning", 200))).toBe(false);
    expect((await points.account("user1"))?.balance).toBe(40);
    expect((await points.day("user1", "2026-11-02"))?.earned).toBe(40);
    const spent = await Promise.all([points.levelUp("user1", 30, levelEntry), points.levelUp("user1", 30, levelEntry)]);
    expect(spent.filter(Boolean)).toHaveLength(1);
    expect(await new PostgresPointsStore(db).account("user1")).toEqual({userId: "user1", balance: 10, earnedTotal: 40, level: 2, streak: 0, lastVisitDay: null});
    expect(await points.levels()).toEqual(new Map([["user1", 2]]));
    expect(await points.leaderboard("embers")).toEqual([{userId: "user1", count: 40}]);
    expect((await points.history("user1", 10)).reduce((sum, item) => sum + item.amount, 0)).toBe(10);
    expect(await points.countSince("user1", "chat", 1000)).toBe(1);
    expect(await points.countSince("user1", "level", 1000)).toBe(0);
    expect(await points.recorded(["earning", "level-2", "missing"])).toEqual(new Set(["earning", "level-2"]));
    await points.setStreak("user1", "2026-11-02", 3);
    expect((await points.account("user1"))?.streak).toBe(3);
    await points.earn({...earned("achievement", 0), kind: "quest", detail: "achievement:synthetic"});
    expect(await points.achievementAwards("user1")).toEqual([{userId: "user1", achievementId: "synthetic", at: 1000}]);
  });
  it("rolls back a failed level ledger and an unsafe aggregate without losing balance or granting a level", async () => {
    const points = new PostgresPointsStore(db);
    await points.earn(earned("earning"));
    await expect(points.levelUp("user1", 30, () => { throw new Error("ledger callback failed"); })).rejects.toThrow("callback failed");
    expect((await points.account("user1"))?.balance).toBe(40);
    expect((await points.account("user1"))?.level).toBe(1);
    await expect(points.levelUp("user1", -30, levelEntry)).rejects.toThrow("positive exact integer");
    await expect(points.levelUp("user1", 30, level => ({...levelEntry(level), userId: "user2"}))).rejects.toThrow("does not match");
    expect((await points.account("user1"))?.balance).toBe(40);
    await points.deleteForUser("user1");
    await points.earn(earned("safe-max", Number.MAX_SAFE_INTEGER));
    await expect(points.earn(earned("overflow", 1))).rejects.toThrow("safe range");
    expect((await points.account("user1"))?.balance).toBe(Number.MAX_SAFE_INTEGER);
    expect(await points.recorded(["overflow"])).toEqual(new Set());
    await expect(points.earn({...earned("missing-user"), userId: "missing-owner"})).rejects.toMatchObject({code: "23503"});
    expect(await points.recorded(["missing-user"])).toEqual(new Set());
  });
  it("bounds unique daily activity under concurrency and prevents recreation after the identity tombstone", async () => {
    const points = new PostgresPointsStore(db);
    const recorded = await Promise.all(Array.from({length: 12}, (_, n) => points.addToDay("user1", "2026-11-02", "minutes", n, 3)));
    expect(recorded.filter(value => value !== null)).toHaveLength(3);
    const day = await points.day("user1", "2026-11-02");
    expect(day?.minutes.length).toBe(3);
    expect(new Set(day?.minutes).size).toBe(3);
    expect((await Promise.all([points.addToDay("user1", "2026-11-02", "chats", "conversation1", 2), points.addToDay("user1", "2026-11-02", "chats", "conversation1", 2)])).filter(value => value !== null)).toHaveLength(1);
    expect(await points.addToDay("user1", "unused", "minutes", 1, 0)).toBeNull();
    expect(await points.day("user1", "unused")).toBeNull();
    await points.deleteForUser("user1");
    await db.query("UPDATE meldiq.users SET deleted_at=1000 WHERE id='user1'");
    expect(await points.earn(earned("after-delete"))).toBe(false);
    expect(await points.addToDay("user1", "2026-11-02", "minutes", 1, 3)).toBeNull();
    expect(await points.account("user1")).toBeNull();
    expect(await points.day("user1", "2026-11-02")).toBeNull();
  });
  it("settles an invite once and exposes credited rankings without private balances", async () => {
    const points = new PostgresPointsStore(db);
    await db.query("INSERT INTO meldiq.orgs(id,name,slug,created_by,created_at,updated_at) VALUES('org1','Synthetic','synthetic','user1',1000,1000)");
    const invite = {id: "org1|user2", inviterId: "user1", joinerId: "user2", orgId: "org1", joinedAt: 1000, state: "pending" as const, settledAt: null};
    await Promise.all([points.addInvite(invite), points.addInvite(invite)]);
    expect(await points.invitesBy("user1")).toEqual([invite]);
    expect((await Promise.all([points.settleInvite(invite.id, "credited", 2000), points.settleInvite(invite.id, "credited", 2000)])).filter(Boolean)).toHaveLength(1);
    expect(await points.leaderboard("invites")).toEqual([{userId: "user1", count: 1}]);
    await points.deleteForUser("user2");
    expect(await points.invitesBy("user1")).toEqual([]);
  });
  it("moderates a decoration once, retains exact rendering metadata and keeps wearer counts nonnegative", async () => {
    const decorations = new PostgresDecorationStore(db);
    const decoration = {id: "decoration1", creatorId: "user1", name: "Synthetic", status: "pending" as const, format: "webp" as const, animated: true,
      size: 2048, createdAt: 1000, reviewedAt: null, reviewedBy: null, reason: null, wearers: 0};
    await decorations.insert(decoration);
    expect(await new PostgresDecorationStore(db).get(decoration.id)).toEqual(decoration);
    expect(await decorations.countPending("user1")).toBe(1);
    const approved = {status: "approved" as const, reviewedAt: 2000, reviewedBy: "account1", reason: null};
    expect((await Promise.all([decorations.review(decoration.id, ["pending"], approved), decorations.review(decoration.id, ["pending"], approved)])).filter(Boolean)).toHaveLength(1);
    await decorations.addWearers(decoration.id, 2); await decorations.addWearers(decoration.id, -5);
    expect((await decorations.get(decoration.id))?.wearers).toBe(0);
    await decorations.setWearers(decoration.id, 3);
    expect((await decorations.approved())[0].wearers).toBe(3);
    expect((await decorations.page("approved", null, 10)).items).toHaveLength(1);
    expect(await decorations.byCreator("user2")).toEqual([]);
    await decorations.remove(decoration.id); expect(await decorations.get(decoration.id)).toBeNull();
  });
});

describe("PostgreSQL-only staged Fastify composition", () => {
  it("rejects a pool that would leave no query connection after reserving its writer lease", async () => {
    const single = new MeldiqPostgres({url: endpoint.href, environment: "development", maxConnections: 1});
    try {await expect(openPostgresRuntime(single)).rejects.toThrow("at least one query connection");}
    finally {await single.close();}
  });
  it("starts with PostgreSQL repositories, persists registered identities/conversations and blocks legacy SQL", async () => {
    const h = await startServer({}, {postgres: db});
    try {
      expect(h.ctx.mongo).toBeUndefined();
      expect(h.ctx.accounts.store.backend).toBe("postgres");
      expect(h.ctx.files.backend).toBe("postgres");
      expect(h.ctx.messages.backend).toBe("postgres");
      expect(h.ctx.billing.rows).toBe(h.ctx.identity);
      const health = await h.app.inject({method: "GET", url: "/healthz"});
      expect(health.statusCode).toBe(200);
      const alice = await h.client("pgruntimealice"), bob = await h.client("pgruntimebob");
      const conversation = (await alice.req("POST", "/v1/conversations/dm", {userId: bob.userId})).conversation;
      expect((await db.query("SELECT id FROM meldiq.users WHERE id=$1", [alice.userId])).rowCount).toBe(1);
      expect((await db.query("SELECT id FROM meldiq.conversations WHERE id=$1", [conversation.id])).rowCount).toBe(1);
      expect(h.ctx.postgres?.legacySqlAttempts).toBe(0);
      expect(() => h.ctx.db.prepare("SELECT * FROM users")).toThrow("Legacy SQL access");
      expect(h.ctx.postgres?.legacySqlAttempts).toBe(1);
    } finally { await h.close(); }
  });
  it("rejects cached authorization and native queries after losing its writer session", async () => {
    const runtime = await openPostgresRuntime(db);
    try {
      const lease = (await db.query<{pid: number}>(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock'
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND granted`)).rows;
      expect(lease).toHaveLength(1);
      await admin.query("SELECT pg_terminate_backend($1)", [lease[0].pid]);
      await expect.poll(() => runtime.rows.available, {timeout: 2000}).toBe(false);
      expect(() => runtime.rows.get("users", {id: "user1"})).toThrow("lease is unavailable");
      await expect(runtime.files.attachment("anything")).rejects.toThrow("lease is unavailable");
    } finally { await runtime.close(); }
    expect((await db.query("SELECT 1 AS value")).rows[0].value).toBe(1);
  });
});
