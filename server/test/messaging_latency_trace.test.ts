import crypto from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,expect,it,describe,vi} from "vitest";
import {startServer,type Harness,expectStatus} from "./support/harness.js";
import {canonical,GriipClient,sign} from "./support/griipClient.js";

// This harness only permits disposable loopback PostgreSQL. Logs contain statement roles, never binds.
describe.skipIf(!process.env.MELDIQ_TEST_PG_URL || process.env.MELDIQ_TEST_PG_DELIVERY_MODE!=="legacy")("leased PostgreSQL delivery",()=>{
 let h:Harness, sender:GriipClient, receiver:GriipClient, group:string;
 beforeAll(async()=>{
  h=await startServer({PLATFORM_SECRETS_KEY:crypto.randomBytes(32).toString("hex")});
  sender=await h.client("latencysender");
  receiver=new GriipClient(h.baseUrl,sender.username);receiver.identity=sender.identity;
  const {nonce}=await receiver.req("POST","/v1/auth/challenge");
  const added=await receiver.req("POST","/v1/auth/add-device",{username:sender.username,device:{name:"tablet",signingKey:receiver.signingKeyB64,encryptionKey:receiver.encKeyB64,certificate:receiver.certificate()},nonce,signature:sign(receiver.device,canonical.authProof("add-device",nonce,receiver.signingKeyB64))});
  Object.assign(receiver,{userId:added.userId,deviceId:added.deviceId,token:added.sessionToken});
  group=(await sender.req("POST","/v1/conversations/group",{name:"private",memberIds:[sender.userId]})).conversation.id;
 });
 afterAll(async()=>{await h?.close();});
 const body=()=>({messageId:crypto.randomUUID(),conversationId:group,cls:"control",audience:"self",sentAt:Date.now(),payload:{type:"test"}});
 const login=(nonce:string)=>receiver.req("POST","/v1/auth/login",{deviceId:receiver.deviceId,nonce,signature:sign(receiver.device,canonical.authProof("login",nonce,receiver.signingKeyB64))});
 it("traces each workflow operation on real PostgreSQL",async()=>{
  const q=vi.spyOn(pg.Client.prototype,"query");
  const trace:Record<string,string[]>={};
  const step=async<T>(k:string,run:()=>Promise<T>)=>{
   q.mockClear();const result=await run();
   trace[k]=q.mock.calls.map(args=>{
    const sql=String(args[0]);
    if(sql.includes("WITH saved"))return "commit history + queue";
    if(sql.includes("apply_row_changes"))return "commit "+[...new Set(JSON.parse(String((args[1] as unknown[])[0])).map((r:{table:string})=>r.table))].join("+");
    if(sql.includes("FROM meldiq.message_events WHERE id"))return "read history by id";
    if(sql.includes("INSERT INTO meldiq.message_events"))return "insert history";
    return sql.split(" ").slice(0,2).join(" ");
   });return result;
  };
  try{
   const c=await step("challenge",()=>receiver.req("POST","/v1/auth/challenge"));
   const r=await step("login",()=>login(c.nonce));receiver.token=r.sessionToken;
   await step("membership",()=>sender.req("GET","/v1/conversations/"+group+"/members"));
   const b=body();await step("send",()=>sender.req("POST","/v2/messages",b));
   const page=await step("queue",()=>receiver.req("GET","/v1/queue"));
   const id=page.items.find((i:{messageId:string})=>i.messageId===b.messageId).id;
   await step("ack",()=>receiver.req("POST","/v1/queue/ack",{ids:[id]}));
   expect((await step("confirm",()=>receiver.req("GET","/v1/queue"))).items.some((i:{id:number})=>i.id===id)).toBe(false);
   process.stdout.write("WORKFLOW_PG "+JSON.stringify(trace)+"\n");
  }finally{q.mockRestore();}
 });
 it("enforces signed nonce expiry, integrity and concurrent single redemption",async()=>{
  const legacy=crypto.randomBytes(24).toString("base64url"),t=Date.now();
  await h.ctx.ephemeral.write(w=>w.insert("auth_challenges",{nonce:legacy,created_at:t,expires_at:t+120_000}));
  expect((await login(legacy)).sessionToken).toBeTruthy();await expectStatus(login(legacy),401);
  const c=await receiver.req("POST","/v1/auth/challenge");
  expect(c.nonce.length).toBe(62);
  const corrupt=(c.nonce[0]==="A"?"B":"A")+c.nonce.slice(1);
  await expectStatus(login(corrupt),401);
  const race=await Promise.allSettled([login(c.nonce),login(c.nonce)]);
  expect(race.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const unused=await receiver.req("POST","/v1/auth/challenge");
  const future=vi.spyOn(Date,"now").mockReturnValue(unused.expiresAt+1);
  try{await expectStatus(login(unused.nonce),401);}finally{future.mockRestore();}
 });
 it("rolls back event, fanout and cache on queue failure; a retry commits exactly once",async()=>{
  const db=h.ctx.postgres!.database,b=body();
  await db.query("CREATE FUNCTION meldiq_private.test_queue_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture queue failure'; END $$; CREATE TRIGGER fail_queue BEFORE INSERT ON meldiq.delivery_queue FOR EACH ROW EXECUTE FUNCTION meldiq_private.test_queue_abort()");
  try{await expectStatus(sender.req("POST","/v2/messages",b),500);}finally{await db.query("DROP TRIGGER fail_queue ON meldiq.delivery_queue; DROP FUNCTION meldiq_private.test_queue_abort()");}
  expect(await h.ctx.messages.get(b.messageId)).toBeNull();
  expect(await h.ctx.relay.submission(b.messageId)).toBeNull();
  const sends=await Promise.all([sender.req("POST","/v2/messages",b),sender.req("POST","/v2/messages",b)]);
  expect(sends.map(r=>r.duplicate).sort()).toEqual([false,true]);expect(sends[0].serverTs).toBe(sends[1].serverTs);
  expect((await receiver.req("GET","/v1/queue")).items.filter((i:{messageId:string})=>i.messageId===b.messageId)).toHaveLength(1);
 });
});
