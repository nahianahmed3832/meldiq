import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, consoleAdmin, type ConsoleAdmin } from "./support/adminConsole.js";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import { accountRows } from "./support/accountRows.js";
import { DEFAULT_SETTINGS, DAY } from "../src/modules/billing/upgradePromotions.js";

const mailer = new MemoryMailer();
let h: Harness, alice: AccountClient, bob: AccountClient, admin: ConsoleAdmin;
describe("authenticated promotion API", () => {
 beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, PLATFORM_SECRETS_KEY: "ab".repeat(32), BILLING_PROVIDER: "sandbox", BILLING_SANDBOX_WEBHOOK_SECRET: "test-only-secret-at-least-thirty-two-characters", WORKFLOW_TICK_MS: "0" }, { mailer });
  alice = await AccountClient.ready(h.baseUrl, mailer, "promo-alice");bob=await AccountClient.ready(h.baseUrl,mailer,"promo-bob");admin=await consoleAdmin(h,mailer,"billing_admin");
  await accountRows(h).setAccount(alice.accountId,{created_at:Date.now()-10*DAY});
  const plan=await h.ctx.billing.catalog.create("plus",{name:"Meldiq Plus",description:"",segment:"personal",public:true,audience:"personal"},{interval:"month",currency:"USD",amountMinor:499,providerPriceRef:"test_plus_499",trialDays:0,graceDays:0,limits:{},notes:""},"test",Date.now());
  await h.ctx.billing.catalog.publish(plan.id,"sandbox","test",Date.now());
 });
 afterAll(async()=>h?.close());
 it("authenticates, denies price injection, and prevents new accounts from seeing a promotion",async()=>{
  const unauth=await fetch(`${h.baseUrl}/v2/billing/promotions/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:randomUUID(),safe:true,screen:"home",trigger:"consistent_usage"})});expect(unauth.status).toBe(401);
  const config={...structuredClone(DEFAULT_SETTINGS),enabled:true,popupsEnabled:true};config.campaigns[0].active=true;
  expect((await admin.browser.req("PUT","/admin/v1/billing/promotions",{settings:config,revision:0,reason:"Test approved safe campaign"})).status).toBe(200);
  await expectStatus(alice.req("POST","/v2/billing/promotions/claim",{sessionId:randomUUID(),safe:true,screen:"home",trigger:"consistent_usage",amountMinor:1}),400);
  expect((await bob.req("POST","/v2/billing/promotions/claim",{sessionId:randomUUID(),safe:true,screen:"home",trigger:"consistent_usage"})).promotion).toBeNull();
 });
 it("reserves once across devices, enforces ownership, opt-out and the immediate kill switch",async()=>{
  const now=Date.now(); const prior=[4*DAY,3*DAY,3*DAY-3_600_000].map(delta=>({id:randomUUID(),startedAt:now-delta-60_000,lastAt:now-delta,activeMs:60_000,completedAt:now-delta}));
  await h.ctx.billing.rows.write(w=>w.upsert("billing_promotion_state",{account_id:alice.accountId,user_id:alice.userId,revision:1,opt_out:0,sessions:JSON.stringify(prior),history:"[]",snoozed_until:0,dismissed_at:null,updated_at:now},"replace"));
  const sessionId=randomUUID();await alice.req("POST","/v2/billing/promotions/activity",{sessionId,onboardingComplete:true,active:true});
  const {promotion:p}=await alice.req("POST","/v2/billing/promotions/claim",{sessionId,safe:true,screen:"home",trigger:"consistent_usage"});expect(p).toMatchObject({amountMinor:499,currency:"USD"});
  expect((await alice.req("POST","/v2/billing/promotions/claim",{sessionId:randomUUID(),safe:true,screen:"home",trigger:"consistent_usage"})).promotion).toBeNull();
  await expectStatus(bob.req("POST","/v2/billing/promotions/events",{sessionId,impressionId:p.id,event:"dismiss"}),404);
  await alice.req("POST","/v2/billing/promotions/events",{sessionId,impressionId:p.id,event:"impression"});
  expect((await alice.req("GET","/v2/billing/promotions/preference")).optOut).toBe(false);
  await alice.req("PUT","/v2/billing/promotions/preference",{optOut:true});
  expect((await alice.req("GET","/v2/billing/promotions/preference")).optOut).toBe(true);
  expect((await bob.req("GET","/v2/billing/promotions/preference")).optOut).toBe(false);expect((await alice.req("GET",`/v2/billing/promotions/${p.id}`)).active).toBe(false);
  const state=await admin.browser.req("GET","/admin/v1/billing/promotions");expect(state.body.metrics.impressions).toBe(1);
  expect((await admin.browser.req("PUT","/admin/v1/billing/promotions",{settings:{...state.body.settings,enabled:false},revision:state.body.revision,reason:"Emergency global kill switch test"})).status).toBe(200);
  expect(h.ctx.platform.count("platform_audit",{action:"billing.promotions.configure"})).toBe(2);
 });
 it("reserves a three-day expiry reminder once per account and period without offering another purchase",async()=>{
  const now=Date.now(), sessionId=randomUUID();
  await expectStatus(bob.req("POST","/v2/billing/reminders/renewal",{sessionId,claim:true,amountMinor:1}),400);
  await h.ctx.billing.rows.write(w=>w.insert("billing_grants",{id:"reminder_grant",account_id:bob.accountId,user_id:bob.userId,plan_key:"plus",source:"gift",reference:"test",starts_at:now-DAY,ends_at:now+4*DAY,created_at:now}));
  expect((await bob.req("POST","/v2/billing/reminders/renewal",{sessionId,claim:true})).notice).toBeNull();
  await h.ctx.billing.rows.write(w=>w.update("billing_grants",{id:"reminder_grant"},{ends_at:now+3*DAY-1000}));
  const first=await bob.req("POST","/v2/billing/reminders/renewal",{sessionId,claim:true});
  expect(first.notice).toMatchObject({autoRenew:false,amountMinor:null,currency:null});
  expect((await bob.req("POST","/v2/billing/reminders/renewal",{sessionId:randomUUID(),claim:true})).notice).toBeNull();
  expect((await bob.req("POST","/v2/billing/reminders/renewal",{sessionId,claim:false})).notice.id).toBe(first.notice.id);
  expect((await alice.req("POST","/v2/billing/reminders/renewal",{sessionId,claim:false})).notice).toBeNull();
  expect((await bob.req("POST","/v2/billing/promotions/claim",{sessionId:randomUUID(),screen:"home",trigger:"consistent_usage",safe:true})).promotion).toBeNull();
  await h.ctx.billing.rows.write(w=>w.update("billing_grants",{id:"reminder_grant"},{ends_at:now-1,starts_at:now-DAY}));
  expect((await bob.req("POST","/v2/billing/reminders/renewal",{sessionId,claim:false})).notice).toBeNull();
 });

 it("uses the subscriber’s immutable amount, excludes add-ons and changes canceled renewals to expiry notices",async()=>{
  const now=Date.now(), sid=randomUUID(), plan=h.ctx.billing.catalog.byKey("plus")!;
  const draft=await h.ctx.billing.catalog.saveDraft(plan.id,{interval:"month",currency:"USD",amountMinor:399,providerPriceRef:"P-HISTORICAL",trialDays:0,graceDays:0,limits:{},notes:"Historical fixture"},"test",now);
  await h.ctx.billing.rows.write(w=>w.update("billing_plan_versions",{id:draft.id},{provider:"paypal",published_at:now-DAY,retired_at:now-1}));
  const sub={id:"reminder_sub",owner_kind:"account",org_id:null,account_id:bob.accountId,owner_user_id:bob.userId,billing_user_id:bob.userId,billing_account_id:bob.accountId,plan_version_id:draft.id,status:"active",provider:"paypal",provider_customer_ref:null,provider_subscription_ref:"I-REMINDER",checkout_id:null,current_period_start:now-28*DAY,current_period_end:now+2*DAY,trial_end:null,cancel_at_period_end:0,canceled_at:null,past_due_since:null,provider_updated_at:now,created_at:now,updated_at:now,quantity:1};
  await h.ctx.billing.rows.write(w=>w.insert("billing_subscriptions",sub));
  const a=await bob.req("POST","/v2/billing/reminders/renewal",{sessionId:sid,claim:true});
  expect(a.notice).toMatchObject({autoRenew:true,amountMinor:399,currency:"USD",months:1});
  await h.ctx.billing.rows.write(w=>w.update("billing_subscriptions",{id:sub.id},{cancel_at_period_end:1}));
  expect((await bob.req("POST","/v2/billing/reminders/renewal",{sessionId:sid,claim:true})).notice.autoRenew).toBe(false);
  await h.ctx.billing.rows.write(w=>w.update("billing_subscriptions",{id:sub.id},{provider:"google_play",current_period_end:now+DAY}));
  expect((await bob.req("POST","/v2/billing/reminders/renewal",{sessionId:sid,claim:true})).notice.amountMinor).toBeNull();
  const spark=await h.ctx.billing.catalog.create("spark",{name:"Spark",description:"",segment:"personal",audience:"personal",public:true},{interval:"month",currency:"USD",amountMinor:99,providerPriceRef:"P-SPARK",trialDays:0,graceDays:0,limits:{},notes:""},"test",now);
  await h.ctx.billing.rows.write(w=>w.update("billing_subscriptions",{id:sub.id},{plan_version_id:h.ctx.billing.catalog.versions(spark.id)[0].id,current_period_end:now+DAY+100}));
  expect((await bob.req("POST","/v2/billing/reminders/renewal",{sessionId:sid,claim:true})).notice).toBeNull();
 });

});
