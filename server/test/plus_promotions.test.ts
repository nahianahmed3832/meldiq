import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { tableSpecs } from "../src/infrastructure/database/mongo/catalog.js";
import { MemoryRows } from "../src/infrastructure/database/rows/memory.js";
import { SqliteRows } from "../src/infrastructure/database/rows/index.js";
import { Campaign, DEFAULT_CAMPAIGN, DEFAULT_SETTINGS, DAY, Promotions, type Subject } from "../src/modules/billing/upgradePromotions.js";
import { PRICING, PLUS_PRICE_MINOR } from "../src/modules/billing/pricing.js";
import { PlanCatalog } from "../src/modules/billing/catalog.js";

class TestMemoryRows extends MemoryRows { readonly backend = "mongodb" as const; constructor() { super(tableSpecs().filter(t => t.domain === "billing")); } protected async persist() {} }
const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(f => f()); });
async function fixture(memory = false) {
 const db = openDatabase(":memory:"); close.push(() => db.close());
 const rows = memory ? new TestMemoryRows() : new SqliteRows(db, tableSpecs().filter(t => t.domain === "billing"));
 let now = Date.UTC(2026, 10, 2, 12);
 const subject: Subject = { accountId: "a1", userId: "u1", createdAt: now - 10 * DAY, registered: true, onboardingComplete: true, plan: "free", excluded: false, checkout: false, region: null };
 const promotions = new Promotions(rows, () => now);
 const config = { ...structuredClone(DEFAULT_SETTINGS), enabled: true, popupsEnabled: true, campaigns: [{ ...DEFAULT_CAMPAIGN, active: true, presentation: "modal" as const }] };
 await promotions.configure(config, 0, "admin");
 const activity = async (id: string) => { await promotions.activity(subject, id, true); for(let j=0;j<4;j++) { now += 15_000; await promotions.activity(subject,id,true); } };
 const familiar = async () => { const saved = now; now -= 4 * DAY; await activity(randomUUID()); now += DAY; await activity(randomUUID()); now += 3_600_000; await activity(randomUUID()); now = saved; };
 const claim = async (id = randomUUID(), s = subject) => { await promotions.activity(s, id, true); return (await promotions.claim(s, { sessionId: id, trigger: "consistent_usage", screen: "home", safe: true })).promotion; };
 return { rows, promotions, subject, config, familiar, claim, activity, set: (t: number) => now = t, advance: (ms: number) => now += ms, now: () => now };
}
for (const memory of [false,true]) describe(`promotion policy (${memory ? "memory mirror" : "SQLite"})`, () => {
 it("defaults off, enforces registration/onboarding/age and three meaningful sessions on two days", async () => {
  const f = await fixture(memory); expect(await f.claim()).toBeNull(); await f.familiar();
  for(const changes of [{registered:false},{onboardingComplete:false},{createdAt:f.now()-3*DAY+1},{plan:"plus"},{plan:"go"},{excluded:true},{checkout:true}]) expect(await f.claim(randomUUID(),{...f.subject,...changes})).toBeNull();
  expect(await f.claim()).not.toBeNull();
 });
 it("reserves atomically across simultaneous devices and applies the rolling 30-day popup cap", async () => {
  const f = await fixture(memory); await f.familiar();
  const results = await Promise.all([f.claim(),f.claim()]); expect(results.filter(Boolean)).toHaveLength(1);
  f.advance(29*DAY); expect(await f.claim()).toBeNull(); f.advance(DAY); expect(await f.claim()).not.toBeNull();
 });
 it("caps all types at three, at least seven days apart and once per session", async () => {
  const f=await fixture(memory); await f.familiar(); f.config.campaigns[0].presentation="banner" as "modal";
  await f.promotions.configure(f.config,1,"admin"); const id=randomUUID(); expect(await f.claim(id)).not.toBeNull();
  f.advance(7*DAY-1); expect(await f.claim()).toBeNull(); f.advance(1); expect(await f.claim(id)).toBeNull(); expect(await f.claim()).not.toBeNull();
  f.advance(7*DAY); expect(await f.claim()).not.toBeNull(); f.advance(7*DAY); expect(await f.claim()).toBeNull();
 });
 it("synchronizes dismissal, snooze and opt-out to a second device", async () => {
  const f=await fixture(memory); await f.familiar(); f.config.campaigns[0].presentation="banner" as "modal"; await f.promotions.configure(f.config,1,"admin");
  const id=randomUUID(), p=(await f.claim(id))!; await f.promotions.feedback(f.subject,{sessionId:id,impressionId:p.id,event:"dismiss"});
  f.advance(14*DAY-1); expect(await f.claim()).toBeNull(); f.advance(1); const nextId=randomUUID(), next=(await f.claim(nextId))!; expect(next).not.toBeNull();
  await f.promotions.feedback(f.subject,{sessionId:nextId,impressionId:next.id,event:"snooze"}); f.advance(30*DAY-1); expect(await f.claim()).toBeNull(); f.advance(1); expect(await f.claim()).not.toBeNull();
  await f.promotions.preference(f.subject,true); f.advance(31*DAY); expect(await f.claim()).toBeNull();
 });
 it("never claims for unsafe contexts, respects the kill switch and withdraws after upgrade", async () => {
  const f=await fixture(memory); await f.familiar(); const id=randomUUID(); await f.promotions.activity(f.subject,id,true);
  expect((await f.promotions.claim(f.subject,{sessionId:id,trigger:"consistent_usage",screen:"home",safe:false})).promotion).toBeNull();
  const p=(await f.claim())!; expect(f.promotions.current({...f.subject,plan:"plus"},p.id).active).toBe(false);
  expect(f.promotions.current({...f.subject,checkout:true},p.id).active).toBe(false);
  await f.promotions.configure({...f.config,enabled:false},1,"admin"); expect(f.promotions.current(f.subject,p.id).active).toBe(false); expect(await f.claim()).toBeNull();
 });
 it("requires a persisted claim for feedback and deduplicates presentation/conversion events", async () => {
  const f=await fixture(memory);await f.familiar();const id=randomUUID(), p=(await f.claim(id))!;
  await expect(f.promotions.feedback({...f.subject,accountId:"other"},{sessionId:id,impressionId:p.id,event:"dismiss"})).rejects.toThrow();
  for(let i=0;i<2;i++) await f.promotions.feedback(f.subject,{sessionId:id,impressionId:p.id,event:"impression"});
  await f.promotions.lifecycle(f.subject.accountId,"conversion","invoice1");await f.promotions.lifecycle(f.subject.accountId,"conversion","invoice2");
  expect(f.promotions.metrics().impressions).toBe(1);expect(f.promotions.metrics().conversions).toBe(1);
 });
});
describe("canonical pricing", () => {
 it("offers Free at zero, Plus at 499 cents monthly and rejects campaign price injection", () => {
  expect(PRICING.free.amountMinor).toBe(0);expect(PLUS_PRICE_MINOR).toBe(499);expect(PRICING.plus.billingInterval).toBe("month");
  expect(Campaign.safeParse({...DEFAULT_CAMPAIGN,amountMinor:1}).success).toBe(false);
  for(const changes of [{gapDays:6},{dismissalDays:13},{snoozeDays:29},{maxImpressions:4},{maxPopups:2},{minAccountDays:2},{minSessions:2}]) expect(Campaign.safeParse({...DEFAULT_CAMPAIGN,...changes}).success).toBe(false);
 });
 it("publishes a new Plus version without rewriting historical terms or provider IDs", async () => {
  const f=await fixture();const catalog=new PlanCatalog(f.rows);
  const terms={interval:"month" as const,currency:"USD",amountMinor:499,providerPriceRef:"P-NEW",trialDays:0,graceDays:0,limits:{},notes:""};
  const plan=await catalog.create("plus",{name:"Meldiq Plus",description:"",segment:"personal",public:true,audience:"personal"},terms,"admin",f.now());
  // A legacy published version is historical seed data, never republished at an unapproved price.
  const legacy=catalog.versions(plan.id)[0]; await f.rows.write(w=>w.update("billing_plan_versions",{id:legacy.id},{amount_minor:399,provider_price_ref:"P-OLD",provider:"paypal",published_at:f.now()-DAY}));
  await catalog.saveDraft(plan.id,terms,"admin",f.now());await catalog.publish(plan.id,"paypal","admin",f.now());
  expect(catalog.byPrice("paypal","P-OLD")?.amount_minor).toBe(399);expect(catalog.current(plan.id)?.amount_minor).toBe(499);
  await catalog.saveDraft(plan.id,{...terms,amountMinor:399,providerPriceRef:"P-WRONG"},"admin",f.now());await expect(catalog.publish(plan.id,"paypal","admin",f.now())).rejects.toThrow(/approved/);
 });
});

it("validates a historical PayPal agreement against its stored price while new subscriptions use 499", async () => {
 const { PayPalProvider } = await import("../src/modules/billing/providers/paypal.js");
 let amount="3.99";
 const provider=new PayPalProvider({clientId:"test",clientSecret:"test",merchantId:"merchant",webhookId:"wh",plusPlanId:"P-NEW",subscriptionsApproved:true,api:{async request(){return {id:"I-OLD",plan_id:"P-OLD",custom_id:"chk_old",status:"ACTIVE",start_time:"2026-01-01T00:00:00Z",billing_info:{last_payment:{amount:{currency_code:"USD",value:amount},time:"2026-11-01T00:00:00Z"},next_billing_time:"2026-12-01T00:00:00Z"}};}}});
 provider.agreementTerms=ref=>ref==="P-OLD"?399:ref==="P-NEW"?499:null;
 expect((await provider.fetchSubscription("I-OLD")).status).toBe("active");
 amount="4.99";await expect(provider.fetchSubscription("I-OLD")).rejects.toThrow(/payment/);
});
