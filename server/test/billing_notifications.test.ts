import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../src/infrastructure/database/db.js";
import { describeTables } from "../src/infrastructure/database/mongo/catalog.js";
import { SqliteRows } from "../src/infrastructure/database/rows/index.js";
import { BillingNotifications } from "../src/modules/billing/notifications.js";
import { MemoryMailer } from "./support/accounts.js";
import { commerceMail } from "../src/infrastructure/mail/commerceMail.js";
const opened: DB[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
describe("billing notification outbox", () => {
 it("deduplicates concurrent receipt jobs, sends verified-account email and retries transient mail failures", async () => {
  const db = openDatabase(":memory:"); opened.push(db); const rows = new SqliteRows(db, describeTables(db).filter(t => t.domain === "billing"));
  const mailer = new MemoryMailer(); let fail = true; const send = mailer.send.bind(mailer); mailer.send = async m => { if (fail) throw new Error("SMTP interrupted"); await send(m); };
  let now = Date.now(); const start = now;
  const outbox = new BillingNotifications(rows, mailer, async () => ({ email: "buyer@example.test", email_verified_at: start }), "https://web.example", () => now, start);
  await rows.write(w => w.insert("mojo_gifts", { id: "gft_receipt", buyer_account_id: "buyer", buyer_user_id: null, recipient_user_id: "recipient", plan_key: "plus", months: 3, currency: "USD", amount_minor: 1197, note: null, status: "paid", provider: "paypal", provider_session_ref: "ORDER", provider_payment_ref: "CAPTURE", grant_id: null, created_at: now, expires_at: now + 86400000, paid_at: now, redeemed_at: null, updated_at: now }));
  await Promise.all([rows.write(w => outbox.queue(w, "buyer", "payment_receipt", "gft_receipt", now)), rows.write(w => outbox.queue(w, "buyer", "payment_receipt", "gft_receipt", now))]);
  expect(rows.count("billing_notification_jobs")).toBe(1);
  expect(await outbox.sweep()).toBe(0); expect(rows.get("billing_notification_jobs", { account_id: "buyer" })).toMatchObject({ status: "failed", attempts: 1, last_error: "billing_mail_failed" });
  expect(JSON.stringify(rows.all("billing_notification_jobs"))).not.toContain("buyer@example.test");
  fail = false; now += 300000; await Promise.all([outbox.sweep(), outbox.sweep()]);
  expect(mailer.sent).toHaveLength(1); expect(mailer.sent[0].text).toContain("$11.97"); expect(mailer.sent[0].html).toContain("cid:");
  expect(await outbox.sweep()).toBe(0);
 });
 it("escapes personal notes and rejects insecure email actions", () => {
  const m = commerceMail("Gift", ['<img src=x onerror="alert(1)">'], { text: "Open", url: "https://web.example/settings/gifts#gift=private" });
  expect(m.html).toContain("&lt;img"); expect(m.html).not.toContain('<img src=x');
  expect(() => commerceMail("Gift", [], { text: "Open", url: "javascript:alert(1)" })).toThrow();
 });
});
