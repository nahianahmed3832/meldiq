/** Real Sandbox resource checks only. No buyer approval, capture, live requests or entitlement grants. */
import fs from "node:fs";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";
if(process.env.PAYPAL_ENVIRONMENT!=="sandbox" || process.env.APP_ENV==="production")throw new Error("Sandbox required");
const prepared=JSON.parse(fs.readFileSync(process.argv[2],"utf8")) as {planId:string;productId:string};
const p=new PayPalProvider({environment:"sandbox",clientId:process.env.PAYPAL_CLIENT_ID!,clientSecret:process.env.PAYPAL_CLIENT_SECRET!,merchantId:process.env.PAYPAL_MERCHANT_ID!,webhookId:process.env.PAYPAL_WEBHOOK_ID??"",plusPlanId:prepared.planId,plusProductId:prepared.productId,subscriptionsApproved:true});
await p.verifyPlusPlan();
const checkout=await p.createCheckout({reference:"meldiq_plus_499_sandbox_verify_v2",priceRef:prepared.planId,trialDays:0,customerRef:null,owner:{kind:"account",id:"sandbox_validation_only"},successUrl:"https://web.meldiq.app/settings/checkout?checkout=success",cancelUrl:"https://web.meldiq.app/settings/checkout?checkout=canceled"});
const subscription=await p.fetchSubscription(checkout.sessionRef);
const order=await p.createPaymentCheckout({reference:"meldiq_plus_499_gift_sandbox_verify_v2",customerRef:null,owner:{kind:"account",id:"sandbox_validation_only"},currency:"USD",amountMinor:499,productName:"Meldiq Plus gift (one month)",successUrl:"https://web.meldiq.app/settings/checkout?gift=success",cancelUrl:"https://web.meldiq.app/settings/checkout?gift=canceled"});
const read=await p.readOrder(order.sessionRef,{reference:"meldiq_plus_499_gift_sandbox_verify_v2",amountMinor:499});
let cleanup="not_attempted";try{await p.cancelSubscription(checkout.sessionRef);cleanup="cancelled";}catch{cleanup="approval_pending_not_cancellable";}
console.log(JSON.stringify({environment:"sandbox",planVerified:true,planId:prepared.planId,productId:prepared.productId,subscription:{created:true,status:subscription.status,paid:subscription.currentPeriodEnd!==null,cleanup},giftOrder:{created:true,amountMinor:read.amountMinor,currency:read.currency,paid:read.paid},buyerApprovalPerformed:false,capturePerformed:false,liveModified:false,webhookTest:"blocked: Sandbox webhook not configured"},null,2));
