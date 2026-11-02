import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";
import type { PayPalApi } from "../src/modules/billing/providers/paypalApi.js";
import { PLUS_TERMS, plusTermViews, type PlusTerm } from "../src/modules/billing/pricing.js";

const ids={monthly:"P-MONTH",quarterly:"P-QUARTER",yearly:"P-YEAR"};
class TermsApi implements PayPalApi {
 calls:{path:string;body:any}[]=[]; subs=new Map<string,any>(); corrupt=false;
 async request(method:string,path:string,body?:any):Promise<any>{
  this.calls.push({path,body});
  if(path.startsWith("/v1/billing/plans/")){const key=(Object.keys(ids) as PlusTerm[]).find(k=>ids[k]===path.split("/").at(-1))!;const t=PLUS_TERMS[key];return {id:ids[key],product_id:"PROD-TEST",status:"ACTIVE",billing_cycles:[{tenure_type:"REGULAR",total_cycles:0,frequency:{interval_unit:t.interval.toUpperCase(),interval_count:this.corrupt?2:t.billingFrequency},pricing_scheme:{fixed_price:{currency_code:"USD",value:(t.amountMinor/100).toFixed(2)}}}]};}
  if(method==="POST"&&path==="/v1/billing/subscriptions"){const id=`I-${this.subs.size+1}`;const s={id,plan_id:body.plan_id,custom_id:body.custom_id,status:"APPROVAL_PENDING",links:[{rel:"approve",href:`https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=${id}`}]};this.subs.set(id,s);return s;}
  if(path.startsWith("/v1/billing/subscriptions/"))return this.subs.get(path.split("/").at(-1)!);
  throw new Error("Unexpected fake provider request");
 }
}
let h:Harness;const mailer=new MemoryMailer(), api=new TermsApi();
describe("approved recurring Plus terms",()=>{
 beforeAll(async()=>{
  const provider=new PayPalProvider({clientId:"public-test",clientSecret:"test-secret",webhookId:"wh",merchantId:"merchant",plusPlanId:ids.monthly,quarterlyPlanId:ids.quarterly,yearlyPlanId:ids.yearly,plusProductId:"PROD-TEST",subscriptionsApproved:true,api});
  h=await startServer({WORKFLOW_TICK_MS:"0"},{mailer,billingProvider:provider});
  let planId="";for(const key of Object.keys(PLUS_TERMS) as PlusTerm[]){const t=PLUS_TERMS[key],terms={interval:t.interval,billingFrequency:t.billingFrequency,currency:"USD",amountMinor:t.amountMinor,providerPriceRef:ids[key],trialDays:0,graceDays:0,limits:{},notes:""};if(!planId){const p=await h.ctx.billing.catalog.create("plus",{name:"Meldiq Plus",description:"",segment:"personal",audience:"personal",public:true},terms,"test",Date.now());planId=p.id;}else await h.ctx.billing.catalog.saveDraft(planId,terms,"test",Date.now());await h.ctx.billing.catalog.publish(planId,"paypal","test",Date.now());}
 });
 afterAll(async()=>h?.close());
 it("keeps all three intervals active on the same Plus product, with exact integer savings",()=>{
  const offers=h.ctx.billing.offers("personal");expect(offers.map(o=>[o.term,o.amountMinor]).sort()).toEqual([["monthly",499],["quarterly",1299],["yearly",4999]].sort());
  expect(plusTermViews().map(t=>[t.months,t.amountMinor,t.savingsMinor])).toEqual([[1,499,0],[3,1299,198],[12,4999,989]]);
  expect(h.ctx.billing.catalog.current(h.ctx.billing.catalog.byKey("plus")!.id)?.amount_minor).toBe(499);
  expect(h.ctx.gifts.price("plus",3)?.amountMinor).toBe(1299);expect(h.ctx.gifts.price("plus",12)?.amountMinor).toBe(4999);
 });
 for(const term of Object.keys(PLUS_TERMS) as PlusTerm[])it(`creates ${term} from server-owned terms and refuses a submitted price`,async()=>{
  const user=await AccountClient.ready(h.baseUrl,mailer,`terms-${term}`);
  const t=PLUS_TERMS[term];
  await expectStatus(user.req("POST","/v2/billing/paypal/checkouts",{product:"plus",term,requestKey:randomUUID(),amountMinor:1}),400);
  const quote=await user.req("POST","/v2/billing/paypal/checkouts",{product:"plus",term,requestKey:randomUUID()});
  expect(quote).toMatchObject({amountMinor:t.amountMinor,interval:t.interval,billingFrequency:t.billingFrequency,confirmed:false});
  expect(api.calls.filter(c=>c.path==="/v1/billing/subscriptions").at(-1)?.body).toMatchObject({plan_id:ids[term]});
 });
 it("verifies the provider cadence and preserves the three-month entitlement period",async()=>{
  const p=h.ctx.billing.provider as PayPalProvider;api.corrupt=true;await expect(p.verifyPlusPlan("quarterly")).rejects.toThrow();api.corrupt=false;
  api.subs.set("I-PAID-Q",{id:"I-PAID-Q",plan_id:ids.quarterly,custom_id:"chk_paid_q",status:"ACTIVE",start_time:"2026-01-31T12:00:00Z",billing_info:{last_payment:{amount:{currency_code:"USD",value:"12.99"},time:"2026-01-31T12:00:00Z"},cycle_executions:[{tenure_type:"REGULAR",cycles_completed:1}]}});
  expect((await p.fetchSubscription("I-PAID-Q")).currentPeriodEnd).toBe(Date.parse("2026-04-30T12:00:00Z"));
 });
});
