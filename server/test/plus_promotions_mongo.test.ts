import { randomUUID } from "node:crypto";
import { afterAll, expect, inject, it } from "vitest";
import { tableSpecs } from "../src/infrastructure/database/mongo/catalog.js";
import { MeldiqMongo } from "../src/infrastructure/database/mongo/client.js";
import { mongoConfig } from "../src/infrastructure/database/mongo/config.js";
import { MongoRows } from "../src/infrastructure/database/rows/index.js";
import { DEFAULT_SETTINGS, DAY, Promotions, type Subject } from "../src/modules/billing/upgradePromotions.js";
import { testDbName } from "./support/mongo.js";

let mongo: MeldiqMongo | undefined;
const opened: MongoRows[] = [];
afterAll(async () => { for(const rows of opened) await rows.close(); if(mongo) { await mongo.db.dropDatabase(); await mongo.close(); } });
it("commits only one promotion reservation from two stale MongoDB mirrors and retains it after restart", async () => {
 const specs=tableSpecs().filter(t=>t.name.startsWith("billing_promotion_"));
 const cfg=mongoConfig({MONGODB_URI:inject("mongoUri"),MONGODB_DB:testDbName("plus_promotions")},"development",(_n,d)=>d)!;
 mongo=await MeldiqMongo.connect(cfg,specs); const a=await MongoRows.open(mongo,specs);opened.push(a);
 const now=Date.UTC(2026,10,2), campaign={...structuredClone(DEFAULT_SETTINGS),enabled:true,popupsEnabled:true};campaign.campaigns[0].active=true;
 const pa=new Promotions(a,()=>now);await pa.configure(campaign,0,"admin");const sessions=[randomUUID(),randomUUID()];
 await a.write(w=>w.insert("billing_promotion_state",{account_id:"a",user_id:"u",revision:1,opt_out:0,sessions:JSON.stringify([...sessions.map(id=>({id,startedAt:now,lastAt:now,activeMs:0,completedAt:null})),...[2*DAY,3*DAY,3*DAY+3600000].map(delta=>({id:randomUUID(),startedAt:now-delta-60000,lastAt:now-delta,activeMs:60000,completedAt:now-delta}))]),history:"[]",snoozed_until:0,dismissed_at:null,updated_at:now}));
 const b=await MongoRows.open(mongo,specs);opened.push(b);const pb=new Promotions(b,()=>now);
 const subject:Subject={accountId:"a",userId:"u",createdAt:now-10*DAY,registered:true,onboardingComplete:true,plan:"free",excluded:false,checkout:false,region:null};
 const claims=await Promise.allSettled([pa.claim(subject,{sessionId:sessions[0],trigger:"consistent_usage",screen:"home",safe:true}),pb.claim(subject,{sessionId:sessions[1],trigger:"consistent_usage",screen:"home",safe:true})]);
 expect(claims.filter(c=>c.status==="fulfilled"&&c.value.promotion)).toHaveLength(1);
 const c=await MongoRows.open(mongo,specs);opened.push(c);expect(JSON.parse(c.get<{history:string}>("billing_promotion_state",{account_id:"a"})!.history)).toHaveLength(1);
 expect((await new Promotions(c,()=>now).claim(subject,{sessionId:sessions[1],trigger:"consistent_usage",screen:"home",safe:true})).promotion).toBeNull();
});
