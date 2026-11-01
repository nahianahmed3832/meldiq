/** Real Sandbox API/webhook probe on a disposable local database. No buyer approval or capture. */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";
import { PayPalCheckout } from "../src/modules/billing/paypalCheckout.js";
import { AccountClient, MemoryMailer } from "../test/support/accounts.js";
import { buildApp } from "../src/app/server.js";
import { loadConfig } from "../src/app/config.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (
  process.env.PAYPAL_ENVIRONMENT !== "sandbox" ||
  process.env.APP_ENV === "production"
)
  throw new Error("Sandbox only");
const env = process.env;
const provider = new PayPalProvider({
  clientId: env.PAYPAL_CLIENT_ID!,
  clientSecret: env.PAYPAL_CLIENT_SECRET!,
  merchantId: env.PAYPAL_MERCHANT_ID!,
  webhookId: env.PAYPAL_WEBHOOK_ID!,
  plusPlanId: env.PAYPAL_PLUS_PLAN_ID!,
  subscriptionsApproved: true,
});
if (!provider.options.webhookId)
  throw new Error("Register a temporary Sandbox webhook before probing");
const mailer = new MemoryMailer();
const dir = mkdtempSync(join(tmpdir(), "meldiq-paypal-probe-"));
const config = loadConfig({
  APP_ENV: "development",
  DATA_DIR: dir,
  LOG_LEVEL: "silent",
  REGISTRATION_MODE: "open",
  MAIL_TRANSPORT: "none",
  PASSWORD_SCRYPT_LOG_N: "10",
  BILLING_PROVIDER: "none",
  BILLING_RETURN_URL: "http://127.0.0.1:5173/settings/checkout",
  BILLING_WEB_RETURN_URL: "http://127.0.0.1:5173/settings/checkout",
  WORKFLOW_TICK_MS: "0",
});
config.billing.provider = provider;
config.billing.unavailableReason = null;
const h = await buildApp(config, { logger: false, mailer });
await h.app.listen({ host: "127.0.0.1", port: 0 });
const address = h.app.server.address();
const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
const proxy = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/billing/webhooks/paypal") {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 262144) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const response = await h.app.inject({
    method: "POST",
    url: req.url,
    headers: { ...req.headers, host: "127.0.0.1" },
    payload: Buffer.concat(chunks).toString("utf8"),
  });
  res
    .writeHead(response.statusCode, { "content-type": "application/json" })
    .end(response.body);
  console.log(
    JSON.stringify({
      sandboxWebhookStatus: response.statusCode,
      processing: response.json().status ?? response.json().error?.code,
    }),
  );
});
await new Promise<void>((resolve) => proxy.listen(18999, "127.0.0.1", resolve));
try {
  await provider.verifyPlusPlan();
  const plan = await h.ctx.billing.catalog.create(
    "plus",
    {
      name: "Mojo Plus",
      description: "Sandbox probe",
      segment: "personal",
      public: true,
      audience: "personal",
    },
    {
      interval: "month",
      currency: "USD",
      amountMinor: 399,
      providerPriceRef: provider.options.plusPlanId!,
      trialDays: 0,
      graceDays: 0,
      limits: {},
      notes: "Sandbox probe only",
    },
    "sandbox-probe",
    Date.now(),
  );
  await h.ctx.billing.catalog.publish(
    plan.id,
    "paypal",
    "sandbox-probe",
    Date.now(),
  );
  const buyer = await AccountClient.ready(baseUrl, mailer, "sandboxprobe");
  const service = new PayPalCheckout(h.ctx.billing, h.ctx.gifts);
  const started = await service.start(
    {
      accountId: buyer.accountId,
      userId: buyer.userId,
      email: null,
      name: null,
    },
    { product: "plus", requestKey: randomUUID() },
  );
  console.log(
    JSON.stringify({
      realSandboxSubscriptionCreated: !!started.providerRef,
      amountMinor: started.amountMinor,
      confirmed: started.confirmed,
      buyerApproval: false,
      realMoney: false,
    }),
  );
  const deadline = Date.now() + 120_000;
  let delivered = false;
  while (Date.now() < deadline) {
    const rows = h.ctx.billing.rows.all<{ status: string; type: string }>(
      "billing_provider_events",
      { where: { provider: "paypal" } },
    );
    if (
      rows.some(
        (r) =>
          r.status === "processed" && r.type === "BILLING.SUBSCRIPTION.CREATED",
      )
    ) {
      delivered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  console.log(
    JSON.stringify({
      realSandboxSignatureVerificationAndDurableProcessing: delivered,
      entitlementsGranted:
        h.ctx.mojo.planOf(buyer.userId, Date.now()) !== "free",
      productionChanged: false,
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      sandboxProbe: "failed",
      category: e instanceof Error ? e.name : "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await h.app.close();
  h.ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
  await provider.api.request(
    "DELETE",
    `/v1/notifications/webhooks/${provider.options.webhookId}`,
  );
  const file = ".env.paypal.sandbox";
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      /^PAYPAL_WEBHOOK_ID=.*$/m,
      "PAYPAL_WEBHOOK_ID=",
    ),
    { mode: 0o600 },
  );
  console.log(
    "Temporary Sandbox webhook removed; private configuration needs a persistent test endpoint before interactive use.",
  );
}
