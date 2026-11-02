import { createHash, randomBytes } from "node:crypto";
import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import type { SecretBox } from "../../infrastructure/crypto/secretBox.js";
import type { Mailer } from "../../infrastructure/mail/mailer.js";
import { commerceMail } from "../../infrastructure/mail/commerceMail.js";
import { ApiError, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import type { GiftRow } from "./gifts.js";

export type GiftTarget = { kind: "user"; userId: string } | { kind: "email"; email: string } | { kind: "link" };
export interface GiftDeliveryRow { gift_id: string; recipient_kind: "user" | "email" | "link"; recipient_email_encrypted: string | null; recipient_email_hash: string | null; token_hash: string | null; redemption_expires_at: number | null; delivery_status: string; delivered_at: number | null; redeemed_by: string | null; revoked_at: number | null; revoked_by: string | null; created_at: number; updated_at: number }
const DAY = 86400000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const normalizedGiftEmail = (value: string) => value.trim().toLowerCase();
interface Job { id: string; gift_id: string; status: string; attempts: number; lease_until: number | null }

/** Only token hashes are persisted. Email retries generate a new link rather than retaining recoverable tokens. */
export class GiftDelivery {
  constructor(private readonly rows: Rows, private readonly secrets: SecretBox, private readonly mailer: Mailer, private readonly webUrl: string, private readonly clock: () => number = Date.now, private readonly redemptionDays = 365) {}
  get(id: string, r = this.rows): GiftDeliveryRow | null { return r.get<GiftDeliveryRow>("mojo_gift_deliveries", { gift_id: id }) ?? null; }
  private emailHash(email: string) { return this.secrets.fingerprint(normalizedGiftEmail(email), "gift-recipient-email:v1"); }
  validate(target: GiftTarget): GiftTarget {
    if (target.kind !== "email") return target;
    const email = normalizedGiftEmail(target.email);
    if (!/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) || email.length > 254) throw new ApiError(400, "bad_request", "Enter a valid gift recipient email.");
    if (!this.secrets.available || !this.mailer.available) throw new ApiError(503, "unavailable", "Email gift delivery is unavailable. Choose a friend or a gift link.");
    return { kind: "email", email };
  }
  matches(row: GiftDeliveryRow | null, target: GiftTarget) { return row ? row.recipient_kind === target.kind && row.recipient_email_hash === (target.kind === "email" ? this.emailHash(target.email) : null) : target.kind === "user"; }
  prepare(w: RowWriter, giftId: string, target: GiftTarget, t: number) {
    w.insert("mojo_gift_deliveries", { gift_id: giftId, recipient_kind: target.kind, recipient_email_encrypted: target.kind === "email" ? this.secrets.seal(target.email, `gift-email:${giftId}`) : null, recipient_email_hash: target.kind === "email" ? this.emailHash(target.email) : null, token_hash: null, redemption_expires_at: null, delivery_status: "awaiting_payment", delivered_at: null, redeemed_by: null, revoked_at: null, revoked_by: null, created_at: t, updated_at: t });
  }
  paid(w: RowWriter, gift: GiftRow, t: number) {
    const delivery = w.get<GiftDeliveryRow>("mojo_gift_deliveries", { gift_id: gift.id });
    if (!delivery || delivery.revoked_at || delivery.redemption_expires_at !== null) return;
    w.update("mojo_gift_deliveries", { gift_id: gift.id }, { redemption_expires_at: t + this.redemptionDays * DAY, delivery_status: delivery.recipient_kind === "user" ? "delivered" : "awaiting_recipient", delivered_at: delivery.recipient_kind === "user" ? t : null, updated_at: t });
    if (delivery.recipient_kind === "email") this.enqueue(w, gift.id, `gift-delivery:${gift.id}`, t);
  }
  private enqueue(w: RowWriter, giftId: string, key: string, t: number) {
    w.insert("billing_notification_jobs", { id: newId("bnj"), dedupe_key: key, gift_id: giftId, account_id: null, kind: "gift_delivery", status: "pending", attempts: 0, lease_until: null, next_attempt_at: t, created_at: t, sent_at: null, last_error: null }, { orIgnore: true });
  }
  receivedForEmail(email: string) { if (!this.secrets.available) return []; return this.rows.all<GiftDeliveryRow>("mojo_gift_deliveries", { where: { recipient_email_hash: this.emailHash(email) }, orderBy: [["created_at", "desc"]], limit: 100 }).map(d => d.gift_id); }
  maskedRecipient(id: string) {
    const d = this.get(id);
    if (!d?.recipient_email_encrypted || !this.secrets.available) return null;
    const email = this.secrets.open(d.recipient_email_encrypted, `gift-email:${id}`);
    const [local, domain] = email.split("@");
    return `${local.slice(0, 2)}•••@${domain}`;
  }
  private assertAvailable(gift: GiftRow | undefined, d: GiftDeliveryRow | undefined | null, t: number): asserts gift is GiftRow {
    if (!gift || !d) throw notFound("Gift not found");
    if (d.revoked_at || d.redemption_expires_at !== null && d.redemption_expires_at <= t) throw forbidden("This gift is no longer available.");
    if (gift.status !== "paid" && gift.status !== "redeemed") throw forbidden("This gift has no verified payment.");
  }
  check(w: RowWriter, giftId: string, t: number) {
    const delivery = w.get<GiftDeliveryRow>("mojo_gift_deliveries", { gift_id: giftId });
    if (delivery && (delivery.revoked_at || delivery.redemption_expires_at !== null && delivery.redemption_expires_at <= t)) throw forbidden("This gift is no longer available.");
  }
  state(gift: GiftRow) {
    const d = this.get(gift.id);
    if (gift.status === "refunded") return "refunded";
    if (d?.revoked_at) return "revoked";
    if (gift.status === "redeemed") return "redeemed";
    if (gift.status === "paid" && d?.redemption_expires_at && d.redemption_expires_at <= this.clock()) return "expired";
    if (gift.status === "paid") return d?.delivery_status === "delivered" ? "delivered" : "awaiting_recipient";
    return gift.status === "pending" ? "pending_payment" : gift.status;
  }
  private token(w: RowWriter, giftId: string, t: number): string {
    const token = randomBytes(32).toString("base64url");
    w.update("mojo_gift_deliveries", { gift_id: giftId }, { token_hash: hash(token), updated_at: t });
    return token;
  }
  link(token: string) { const url = new URL("/settings/gifts", this.webUrl); url.hash = `gift=${token}`; return url.href; }
  async share(accountId: string, giftId: string) {
    return this.rows.write(w => {
      const g = w.get<GiftRow>("mojo_gifts", { id: giftId, buyer_account_id: accountId });
      if (!g) throw notFound("Gift not found");
      let d = w.get<GiftDeliveryRow>("mojo_gift_deliveries", { gift_id: giftId });
      if (!d) { this.prepare(w, giftId, { kind: "user", userId: g.recipient_user_id }, this.clock()); this.paid(w, g, this.clock()); d = w.get<GiftDeliveryRow>("mojo_gift_deliveries", { gift_id: giftId }); }
      this.assertAvailable(g, d, this.clock());
      if (g.status === "redeemed") throw conflict("This gift has already been redeemed.");
      if (d!.recipient_kind === "email" && w.get("billing_notification_jobs", { gift_id: giftId, status: { in: ["pending", "failed", "sending"] } })) throw conflict("Email delivery is pending. Wait for it to finish before replacing the gift link.");
      const token = this.token(w, giftId, this.clock());
      return { giftId, url: this.link(token), expiresAt: d!.redemption_expires_at };
    });
  }
  find(token: string, r: Pick<Rows, "get"> = this.rows) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound("Gift not found");
    const delivery = r.get<GiftDeliveryRow>("mojo_gift_deliveries", { token_hash: hash(token) });
    const gift = delivery ? r.get<GiftRow>("mojo_gifts", { id: delivery.gift_id }) : undefined;
    this.assertAvailable(gift, delivery, this.clock());
    return { gift, delivery: delivery! };
  }
  authorize(w: RowWriter, token: string, recipient: { accountId: string; userId: string; verifiedEmail: string | null }) {
    const { gift, delivery } = this.find(token, w);
    return this.authorizeRecipient(w, gift, delivery, recipient);
  }
  authorizeRecipient(w: RowWriter, gift: GiftRow, delivery: GiftDeliveryRow, recipient: { accountId: string; userId: string; verifiedEmail: string | null }) {
    this.assertAvailable(gift, delivery, this.clock());
    if (gift.buyer_account_id === recipient.accountId) throw forbidden("Gifts are for someone else.");
    if (delivery.redeemed_by && delivery.redeemed_by !== recipient.accountId) throw forbidden("This gift has already been claimed.");
    if (delivery.recipient_kind === "user" && gift.recipient_user_id !== recipient.userId) throw notFound("Gift not found");
    if (delivery.recipient_kind === "email" && (!recipient.verifiedEmail || this.emailHash(recipient.verifiedEmail) !== delivery.recipient_email_hash)) throw forbidden("Sign in with the verified email that received this gift.");
    if (gift.recipient_user_id && gift.recipient_user_id !== recipient.userId) throw forbidden("This gift has already been claimed.");
    w.update("mojo_gifts", { id: gift.id }, { recipient_user_id: recipient.userId });
    w.update("mojo_gift_deliveries", { gift_id: gift.id }, { redeemed_by: recipient.accountId, updated_at: this.clock() });
    return { ...gift, recipient_user_id: recipient.userId };
  }
  async resend(accountId: string, giftId: string) {
    await this.rows.write(w => {
      const gift = w.get<GiftRow>("mojo_gifts", { id: giftId, buyer_account_id: accountId });
      const delivery = w.get<GiftDeliveryRow>("mojo_gift_deliveries", { gift_id: giftId });
      this.assertAvailable(gift, delivery, this.clock());
      if (gift.status === "redeemed" || delivery!.recipient_kind !== "email") throw conflict("Only an unclaimed email gift can be resent.");
      const recent = w.get("billing_notification_jobs", { gift_id: giftId, created_at: { gt: this.clock() - 60000 } });
      if (recent) throw conflict("Please wait before requesting another gift email.");
      if (w.get("billing_notification_jobs", { gift_id: giftId, status: "sending", lease_until: { gt: this.clock() } })) throw conflict("A gift email is already being sent. Please check again shortly.");
      w.update("billing_notification_jobs", { gift_id: giftId, status: { in: ["pending", "failed"] } }, { status: "canceled" });
      w.update("mojo_gift_deliveries", { gift_id: giftId }, { delivery_status: "queued", updated_at: this.clock() });
      this.enqueue(w, giftId, `gift-resend:${giftId}:${Math.floor(this.clock() / 60000)}`, this.clock());
    });
    return { queued: true as const };
  }
  async revoke(giftId: string, actor: string) {
    await this.rows.write(w => {
      const gift = w.get<GiftRow>("mojo_gifts", { id: giftId });
      if (!gift) throw notFound("Gift not found");
      if (gift.status === "redeemed") throw conflict("A redeemed gift cannot be revoked through this operation.");
      if (!w.get("mojo_gift_deliveries", { gift_id: giftId })) this.prepare(w, giftId, { kind: "user", userId: gift.recipient_user_id }, this.clock());
      w.update("mojo_gift_deliveries", { gift_id: giftId }, { revoked_at: this.clock(), revoked_by: actor, delivery_status: "revoked", updated_at: this.clock() });
      w.update("billing_notification_jobs", { gift_id: giftId, status: { in: ["pending", "failed"] } }, { status: "canceled" });
    });
  }
  async sweep(): Promise<number> {
    if (!this.mailer.available) return 0;
    const t = this.clock();
    const due = this.rows.all<Job>("billing_notification_jobs", { where: { kind: "gift_delivery", status: { in: ["pending", "failed", "sending"] }, next_attempt_at: { lte: t }, $or: [{ lease_until: null }, { lease_until: { lte: t } }] }, limit: 20 });
    let sent = 0;
    for (const job of due) {
      const claimed = await this.rows.write(w => {
        const current = w.get<Job>("billing_notification_jobs", { id: job.id });
        if (!current || current.status === "sent" || current.status === "canceled" || current.lease_until && current.lease_until > t) return null;
        const gift = w.get<GiftRow>("mojo_gifts", { id: current.gift_id });
        const d = w.get<GiftDeliveryRow>("mojo_gift_deliveries", { gift_id: current.gift_id });
        if (!gift || gift.status !== "paid" || !d || d.revoked_at || !d.recipient_email_encrypted || d.redemption_expires_at !== null && d.redemption_expires_at <= t) { w.update("billing_notification_jobs", { id: job.id }, { status: "canceled" }); return null; }
        const token = this.token(w, gift.id, t);
        w.update("billing_notification_jobs", { id: job.id }, { status: "sending", lease_until: t + 120000, attempts: current.attempts + 1 });
        return { gift, email: this.secrets.open(d.recipient_email_encrypted, `gift-email:${gift.id}`), token, attempts: current.attempts + 1 };
      });
      if (!claimed) continue;
      try {
        const content = commerceMail("You have a Meldiq gift", [`Someone sent you ${claimed.gift.months} month${claimed.gift.months === 1 ? "" : "s"} of Plus.`, ...(claimed.gift.note ? [claimed.gift.note] : []), "This gift is already paid for. Redeeming it does not start a subscription or charge you."], { text: "Open your gift", url: this.link(claimed.token) });
        await this.mailer.send({ to: claimed.email, subject: "You have a Meldiq Plus gift", ...content });
        await this.rows.write(w => { w.update("billing_notification_jobs", { id: job.id }, { status: "sent", sent_at: this.clock(), lease_until: null }); w.update("mojo_gift_deliveries", { gift_id: claimed.gift.id }, { delivery_status: "delivered", delivered_at: this.clock(), updated_at: this.clock() }); });
        sent++;
      } catch {
        await this.rows.write(w => { w.update("billing_notification_jobs", { id: job.id }, { status: claimed.attempts >= 8 ? "blocked" : "failed", lease_until: null, next_attempt_at: this.clock() + Math.min(3600000, 60000 * 2 ** claimed.attempts), last_error: "mail_delivery_failed" }); w.update("mojo_gift_deliveries", { gift_id: claimed.gift.id }, { delivery_status: claimed.attempts >= 8 ? "blocked" : "failed", updated_at: this.clock() }); });
      }
    }
    return sent;
  }
}
