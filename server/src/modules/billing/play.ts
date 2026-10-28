import type { FastifyBaseLogger } from "fastify";
import { ApiError, badRequest, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import type { VersionRow } from "./catalog.js";
import type { PlayConfig } from "./config.js";
import type { Gifts } from "./gifts.js";
import { TERMINAL } from "./lifecycle.js";
import type { BillingOwner } from "./owners.js";
import { SPARK_PLAN_KEY } from "./perks.js";
import {
  ACK_PENDING,
  accountToken,
  type PlayNotification,
  PLAY_PROVIDER,
  type PlayProduct,
  parsePush,
  playProduct,
  playSnapshot,
  tokenHash,
  verifyPushToken,
} from "./providers/googlePlay.js";
import { type SubscriptionSnapshot, WebhookRejected } from "./providers/types.js";
import type { Billing } from "./service.js";
import type { SubscriptionRow } from "./subscriptions.js";

/** What the app is told about a purchase it sent: only `granted` means the server gave something. */
export type PlayVerifyStatus = "granted" | "pending" | "already_linked" | "invalid";

export interface PlayPurchaseRow {
  id: string;
  token_hash: string;
  purchase_token: string;
  product_id: string;
  kind: PlayProduct["kind"];
  account_id: string;
  reference: string | null;
  state: string;
  acknowledged: number;
  consumed: number;
  created_at: number;
  updated_at: number;
  checked_at: number;
}

export interface PlayIntentInput {
  kind: PlayProduct["kind"];
  productId: string;
  /** The person's current Play subscription product when this purchase replaces it (a plan or Spark pack change). */
  replacing?: string | null;
  giftTo?: string | null;
  note?: string | null;
}

/** How long the app has to finish Google's sheet (pending payments clear in days). */
const CHECKOUT_TTL_MS = 7 * 86_400_000;
/** Reconciliation reads a purchase again after this long, or after a few minutes while it's unacknowledged. */
const RECHECK_MS = 6 * 3_600_000;
const UNACKNOWLEDGED_RECHECK_MS = 5 * 60_000;
const RECONCILE_BATCH = 20;
/** States after which Google has nothing new to say about a purchase. */
const FINAL_STATES = ["canceled", "incomplete_expired", "refunded", "failed", "consumed"];

/**
 * Google Play Billing beside the website's provider (docs/MOJO_ANDROID.md). The app asks for an intent (our checkout or
 * gift row, and the opaque account token Google echoes), opens Google's sheet, then sends the purchase token. The server
 * reads the purchase from the Google Play Developer API, checks that it is one of our products, made for this account
 * through one of its own intents, and applies Google's state through the same subscription core and gift rules as
 * Stripe's events. It acknowledges (subscriptions) or consumes (gifts) a purchase only after the grant is stored, so a
 * purchase the server couldn't take is refunded by Google after three days. Google's notifications and an hourly
 * reconciliation re-read purchases; nothing a client or a notification says is applied without asking Google.
 */
export class PlayBilling {
  constructor(
    private readonly billing: Billing,
    private readonly gifts: Gifts,
    readonly config: PlayConfig,
    private readonly log: FastifyBaseLogger,
    private readonly clock: () => number = Date.now,
  ) {
    billing.subscriptions.storeVersion = (provider, priceRef) => (provider === PLAY_PROVIDER ? this.versionFor(priceRef) : null);
  }

  private get rows() {
    return this.billing.rows;
  }

  accountToken(accountId: string): string {
    return accountToken(this.config.accountTokenSecret, accountId);
  }

  /**
   * The plan version a Play subscription product is on: the plan's current published terms (whichever provider they
   * were published for), else its newest published ones. Gifts aren't subscriptions.
   */
  versionFor(productId: string): VersionRow | null {
    const p = playProduct(productId);
    if (!p || p.kind === "gift") return null;
    const plan = this.billing.catalog.byKey(p.kind === "plan" ? p.planKey : SPARK_PLAN_KEY);
    if (!plan) return null;
    return this.billing.catalog.current(plan.id) ?? this.billing.catalog.versions(plan.id).find((v) => v.published_at !== null) ?? null;
  }

  /** Whether Mojo Go or Plus can be bought on Google Play (their plans are published in the catalog). */
  onSale(): boolean {
    return this.versionFor("mojo_go") !== null || this.versionFor("mojo_plus") !== null;
  }

  /** Records what the person is about to buy on Google Play and answers what the app passes to Google's sheet. */
  async intent(starter: { accountId: string; userId: string | null }, input: PlayIntentInput): Promise<{ reference: string; accountToken: string }> {
    const product = playProduct(input.productId);
    if (!product) throw notFound("No such product");
    if (product.kind !== input.kind) throw badRequest(`${input.productId} isn't a ${input.kind}`);
    const reference =
      product.kind === "gift"
        ? (await this.gifts.startStore(starter, { recipientUserId: input.giftTo ?? "", planKey: product.planKey, months: product.months, note: input.note }, PLAY_PROVIDER)).giftId
        : await this.startCheckout({ kind: "account", accountId: starter.accountId }, starter, input.productId, product, input.replacing ?? null);
    return { reference, accountToken: this.accountToken(starter.accountId) };
  }

  private async startCheckout(owner: BillingOwner & { kind: "account" }, starter: { userId: string | null }, productId: string, product: PlayProduct, replacing: string | null): Promise<string> {
    const version = this.versionFor(productId);
    const plan = version ? this.billing.catalog.plan(version.plan_id) : null;
    if (!version || !plan || plan.audience !== "personal") throw new ApiError(409, "billing_unavailable", "Mojo isn't on sale yet");
    const live = product.kind === "spark" ? this.billing.subscriptions.liveAddonForOwner(owner) : this.billing.subscriptions.liveForOwner(owner);
    if (live && live.provider !== PLAY_PROVIDER) throw new ApiError(409, "billed_elsewhere", "This is billed on meldiq.app: change it there");
    if (live && !replacing) throw conflict("You have this on Google Play already: change it there instead");
    if (replacing && (!live || this.productOf(live) !== replacing)) throw conflict("That isn't the subscription you have");
    const t = this.clock();
    const id = newId("chk");
    await this.rows.write((w) =>
      w.insert("billing_checkouts", {
        id, owner_kind: "account", org_id: null, account_id: owner.accountId, user_id: starter.userId, started_by_account_id: owner.accountId,
        plan_version_id: version.id, provider: PLAY_PROVIDER, status: "open", created_at: t, expires_at: t + CHECKOUT_TTL_MS,
        quantity: product.kind === "spark" ? product.quantity : 1,
      }),
    );
    return id;
  }

  /** The Play product a stored Play subscription was bought as. */
  productOf(s: SubscriptionRow): string | null {
    return this.rows.get<PlayPurchaseRow>("billing_play_purchases", { token_hash: s.provider_subscription_ref })?.product_id ?? null;
  }

  purchase(token: string): PlayPurchaseRow | null {
    return this.rows.get<PlayPurchaseRow>("billing_play_purchases", { token_hash: tokenHash(token) }) ?? null;
  }

  /** A purchase token the signed-in app sends (POST /v2/mojo/play/verify). */
  async verify(accountId: string, productId: string, token: string): Promise<PlayVerifyStatus> {
    const product = playProduct(productId);
    if (!product) return "invalid";
    const known = this.purchase(token);
    if (known && known.account_id !== accountId) return "already_linked";
    return product.kind === "gift" ? this.syncProduct(token, productId, accountId) : this.syncSubscription(token, accountId);
  }

  /**
   * Reads a subscription from Google and applies it. [expectAccount]: the signed-in account that sent the token, or
   * null for a notification or reconciliation (the account then comes from the purchase's own checkout).
   */
  async syncSubscription(token: string, expectAccount: string | null, replacement = false): Promise<PlayVerifyStatus> {
    const t = this.clock();
    const sub = await this.config.api.getSubscription(token);
    const snap = sub ? playSnapshot(token, sub, t) : null;
    if (!sub || !snap) return "invalid";
    const hash = snap.ref;
    const known = this.rows.get<PlayPurchaseRow>("billing_play_purchases", { token_hash: hash });
    const checkoutId = sub.externalAccountIdentifiers?.obfuscatedExternalProfileId ?? null;
    const checkout = checkoutId ? this.rows.get<{ account_id: string | null }>("billing_checkouts", { id: checkoutId, provider: PLAY_PROVIDER }) : undefined;
    const account = known?.account_id ?? checkout?.account_id ?? null;
    if (!account || sub.externalAccountIdentifiers?.obfuscatedExternalAccountId !== this.accountToken(account)) return "invalid";
    if (expectAccount && account !== expectAccount) return "already_linked";
    await this.record(token, snap.priceRef, playProduct(snap.priceRef)!.kind, account, checkoutId, snap.status, t);
    // A plan change: Google's new purchase names the one it replaces, which ends now.
    if (sub.linkedPurchaseToken && !replacement) await this.replaced(sub.linkedPurchaseToken, account);
    // One event per change Google reports: reading the same state again (the app and a notification, reconciliation) is
    // a duplicate and isn't stored twice; coming back to an earlier state (on hold, then paid) is a new change.
    const before = this.rows.get<SubscriptionRow>("billing_subscriptions", { provider: PLAY_PROVIDER, provider_subscription_ref: hash });
    const stateRef = `play:${hash}:${before?.status ?? "new"}>${snap.status}:${snap.currentPeriodEnd ?? 0}:${snap.cancelAtPeriodEnd ? 1 : 0}:${snap.priceRef}`;
    const applied = await this.billing.webhooks.ingest(PLAY_PROVIDER, { ref: stateRef, type: `play.${sub.subscriptionState ?? "unknown"}`, createdAt: t, kind: "subscription", subscription: snap });
    if (applied.status === "failed" || applied.status === "dead") this.log.warn({ purchase: hash.slice(0, 12), status: applied.status }, "google play subscription couldn't be applied");
    const row = this.rows.get<SubscriptionRow>("billing_subscriptions", { provider: PLAY_PROVIDER, provider_subscription_ref: hash });
    const granting = !!row && this.billing.subscriptions.grants(row, t);
    if (granting && sub.acknowledgementState === ACK_PENDING) await this.acknowledge(snap.priceRef, token, hash);
    else if (sub.acknowledgementState && sub.acknowledgementState !== ACK_PENDING) await this.mark(hash, { acknowledged: 1 });
    if (granting) return "granted";
    return snap.status === "incomplete" ? "pending" : "invalid";
  }

  /** The subscription [oldToken] was replaced by a newer purchase: Google's state, or ended now if Google still says live. */
  private async replaced(oldToken: string, account: string): Promise<void> {
    const old = this.purchase(oldToken);
    if (!old || old.account_id !== account) return;
    await this.syncSubscription(oldToken, null, true);
    const row = this.rows.get<SubscriptionRow>("billing_subscriptions", { provider: PLAY_PROVIDER, provider_subscription_ref: old.token_hash });
    if (!row || TERMINAL.has(row.status)) return;
    const t = this.clock();
    const ended: SubscriptionSnapshot = {
      ref: row.provider_subscription_ref, customerRef: null, status: "canceled", priceRef: old.product_id, checkoutRef: null, currentPeriodStart: row.current_period_start,
      currentPeriodEnd: t, trialEnd: null, cancelAtPeriodEnd: false, canceledAt: t, quantity: row.quantity,
    };
    await this.billing.webhooks.ingest(PLAY_PROVIDER, { ref: `play:${old.token_hash}:replaced`, type: "play.replaced", createdAt: t + 1, kind: "subscription", subscription: ended });
  }

  /** Reads a one-time purchase (a gift) from Google and applies it to its gift. */
  async syncProduct(token: string, productId: string, expectAccount: string | null): Promise<PlayVerifyStatus> {
    const product = playProduct(productId);
    if (product?.kind !== "gift") return "invalid";
    const t = this.clock();
    const p = await this.config.api.getProduct(productId, token);
    if (!p) return "invalid";
    const hash = tokenHash(token);
    const giftId = p.obfuscatedExternalProfileId ?? null;
    const gift = giftId ? this.gifts.get(giftId) : null;
    const known = this.rows.get<PlayPurchaseRow>("billing_play_purchases", { token_hash: hash });
    const account = known?.account_id ?? gift?.buyer_account_id ?? null;
    if (!gift || gift.provider !== PLAY_PROVIDER || !account || gift.buyer_account_id !== account) return "invalid";
    if (gift.plan_key !== product.planKey || gift.months !== product.months) return "invalid";
    if (p.obfuscatedExternalAccountId !== this.accountToken(account)) return "invalid";
    if (expectAccount && account !== expectAccount) return "already_linked";
    // purchaseState: 0 purchased, 1 canceled, 2 pending.
    if (p.purchaseState === 2) {
      await this.record(token, productId, "gift", account, gift.id, "pending", t);
      return "pending";
    }
    const paid = p.purchaseState === 0;
    await this.record(token, productId, "gift", account, gift.id, paid ? "paid" : "failed", t);
    await this.billing.webhooks.ingest(PLAY_PROVIDER, {
      ref: `play:${hash}:${paid ? "paid" : "canceled"}`, type: paid ? "play.gift_paid" : "play.gift_canceled", createdAt: t, kind: "checkout",
      checkout: { sessionRef: hash, reference: gift.id, outcome: paid ? "completed" : "payment_failed", subscriptionRef: null, customerRef: null, mode: "payment", paid, paymentRef: hash },
    });
    const now = this.gifts.get(gift.id);
    const delivered = !!now && (now.status === "paid" || now.status === "redeemed");
    if (delivered && p.consumptionState !== 1) await this.consume(productId, token, hash);
    else if (p.consumptionState === 1) await this.mark(hash, { consumed: 1, state: "consumed" });
    return delivered ? "granted" : "invalid";
  }

  /** A purchase Google voided (a refund or chargeback). */
  private async voided(token: string, productType: number | undefined): Promise<void> {
    const known = this.purchase(token);
    if (!known) return;
    if (productType === 1 || known.kind !== "gift") {
      await this.syncSubscription(token, null);
      return;
    }
    const t = this.clock();
    await this.billing.webhooks.ingest(PLAY_PROVIDER, {
      ref: `play:${known.token_hash}:voided`, type: "play.voided", createdAt: t, kind: "payment",
      payment: { kind: "refund", ref: `void:${known.token_hash}`, customerRef: null, currency: "USD", amountMinor: 0, affectedMinor: 0, state: "refunded", paymentRef: known.token_hash },
    });
    await this.mark(known.token_hash, { state: "refunded" });
  }

  /** A real-time developer notification (POST /v1/billing/webhooks/google_play). Google's state is read, never the message's. */
  async notification(authorization: string | undefined, body: unknown): Promise<{ ok: true }> {
    const rtdn = this.config.rtdn;
    if (!rtdn) throw notFound();
    try {
      await verifyPushToken(authorization, rtdn, this.config.jwks, this.clock());
    } catch (e) {
      if (!(e instanceof WebhookRejected)) throw e;
      await this.billing.webhooks.reject(PLAY_PROVIDER, e.reason);
      this.log.warn({ provider: PLAY_PROVIDER, reason: e.reason }, "google play notification refused");
      throw new ApiError(401, "bad_signature", "The notification couldn't be verified");
    }
    const push = parsePush(body);
    if (!push) throw badRequest("Expected a Pub/Sub push message");
    await this.apply(push.notification);
    return { ok: true };
  }

  private async apply(n: PlayNotification): Promise<void> {
    // Another app's notification on a shared topic: nothing of ours.
    if (n.packageName !== this.config.packageName) return;
    try {
      if (n.subscriptionNotification?.purchaseToken) await this.syncSubscription(n.subscriptionNotification.purchaseToken, null);
      else if (n.oneTimeProductNotification?.purchaseToken && n.oneTimeProductNotification.sku) {
        await this.syncProduct(n.oneTimeProductNotification.purchaseToken, n.oneTimeProductNotification.sku, null);
      } else if (n.voidedPurchaseNotification?.purchaseToken) await this.voided(n.voidedPurchaseNotification.purchaseToken, n.voidedPurchaseNotification.productType);
    } catch (e) {
      // Google couldn't be asked: Pub/Sub delivers the notification again.
      this.log.warn({ err: e }, "google play notification couldn't be applied yet");
      throw new ApiError(503, "unavailable", "Google Play couldn't be reached");
    }
  }

  /**
   * Reads purchases again (the cleanup job, every minute; a few at a time): unacknowledged ones after a few minutes,
   * the rest every few hours until Google has nothing new to say. Covers notifications that never arrived.
   */
  async reconcile(): Promise<number> {
    const t = this.clock();
    const due = this.rows.all<PlayPurchaseRow>("billing_play_purchases", {
      where: {
        state: { notIn: FINAL_STATES },
        $or: [{ checked_at: { lte: t - RECHECK_MS } }, { acknowledged: 0, consumed: 0, checked_at: { lte: t - UNACKNOWLEDGED_RECHECK_MS } }],
      },
      orderBy: [["checked_at", "asc"]],
      limit: RECONCILE_BATCH,
    });
    for (const p of due) {
      try {
        if (p.kind === "gift") await this.syncProduct(p.purchase_token, p.product_id, null);
        else await this.syncSubscription(p.purchase_token, null);
      } catch (e) {
        this.log.warn({ err: e, purchase: p.token_hash.slice(0, 12) }, "google play reconciliation failed");
      }
      // Asked (or tried): next time in turn, whatever Google answered.
      await this.mark(p.token_hash, { checked_at: Math.max(t, this.clock()) });
    }
    return due.length;
  }

  private async record(token: string, productId: string, kind: PlayProduct["kind"], accountId: string, reference: string | null, state: string, t: number): Promise<void> {
    const hash = tokenHash(token);
    await this.rows.write((w) => {
      const added = w.insert(
        "billing_play_purchases",
        { id: newId("gpp"), token_hash: hash, purchase_token: token, product_id: productId, kind, account_id: accountId, reference, state, acknowledged: 0, consumed: 0, created_at: t, updated_at: t, checked_at: t },
        { orIgnore: true },
      );
      if (!added.inserted) w.update("billing_play_purchases", { token_hash: hash, account_id: accountId }, { state, updated_at: t, checked_at: t });
    });
  }

  private async mark(hash: string, set: Partial<Pick<PlayPurchaseRow, "acknowledged" | "consumed" | "state" | "checked_at">>): Promise<void> {
    await this.rows.write((w) => w.update("billing_play_purchases", { token_hash: hash }, { ...set, updated_at: this.clock() }));
  }

  private async acknowledge(productId: string, token: string, hash: string): Promise<void> {
    try {
      await this.config.api.acknowledgeSubscription(productId, token);
      await this.mark(hash, { acknowledged: 1 });
    } catch (e) {
      // Retried by reconciliation within minutes; Google allows three days.
      this.log.warn({ err: e, purchase: hash.slice(0, 12) }, "google play acknowledgement failed");
    }
  }

  private async consume(productId: string, token: string, hash: string): Promise<void> {
    try {
      await this.config.api.consumeProduct(productId, token);
      await this.mark(hash, { consumed: 1, acknowledged: 1, state: "consumed" });
    } catch (e) {
      this.log.warn({ err: e, purchase: hash.slice(0, 12) }, "google play consume failed");
    }
  }
}
