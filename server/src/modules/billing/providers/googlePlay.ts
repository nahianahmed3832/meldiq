import { createHash, createHmac, createPrivateKey, createPublicKey, createSign, createVerify, type JsonWebKey } from "node:crypto";
import type { SubscriptionStatus } from "../lifecycle.js";
import { type SubscriptionSnapshot, WebhookRejected } from "./types.js";

/**
 * Google Play Billing for the Android app (docs/MOJO_ANDROID.md). Unlike Stripe, Google has no hosted checkout and no
 * signed webhook body: the app buys through Google Play's own sheet and hands the server the purchase token; Google's
 * real-time developer notifications (Pub/Sub push, authenticated with a Google-signed OIDC token) only say that a
 * purchase changed. Either way the server reads the purchase from the Google Play Developer API and applies what Google
 * says, never what the app or the notification claims.
 */
export const PLAY_PROVIDER = "google_play";

/** What each Play Console product is (the ids the owner creates; the Android app uses the same, PlayProducts.kt). */
export type PlayProduct =
  | { kind: "plan"; planKey: "go" | "plus" }
  | { kind: "spark"; quantity: number }
  | { kind: "gift"; planKey: "go" | "plus"; months: 1 | 3 | 12 };

export const PLAY_PRODUCTS: Readonly<Record<string, PlayProduct>> = {
  mojo_go: { kind: "plan", planKey: "go" },
  mojo_plus: { kind: "plan", planKey: "plus" },
  // Google Play can't sell one subscription in a chosen quantity: each Spark pack is its own product, and a person
  // switches between packs (a plan change) rather than holding several.
  spark_1: { kind: "spark", quantity: 1 },
  spark_2: { kind: "spark", quantity: 2 },
  spark_3: { kind: "spark", quantity: 3 },
  spark_5: { kind: "spark", quantity: 5 },
  gift_go_1m: { kind: "gift", planKey: "go", months: 1 },
  gift_go_3m: { kind: "gift", planKey: "go", months: 3 },
  gift_go_12m: { kind: "gift", planKey: "go", months: 12 },
  gift_plus_1m: { kind: "gift", planKey: "plus", months: 1 },
  gift_plus_3m: { kind: "gift", planKey: "plus", months: 3 },
  gift_plus_12m: { kind: "gift", planKey: "plus", months: 12 },
};

export const playProduct = (id: string): PlayProduct | null => (Object.hasOwn(PLAY_PRODUCTS, id) ? PLAY_PRODUCTS[id]! : null);

/** The subset of `purchases.subscriptionsv2` Meldiq reads. */
export interface PlaySubscription {
  subscriptionState?: string;
  startTime?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string; obfuscatedExternalProfileId?: string };
  lineItems?: { productId?: string; expiryTime?: string; autoRenewingPlan?: { autoRenewEnabled?: boolean } }[];
}

/** The subset of `purchases.products` (one-time products) Meldiq reads. purchaseState: 0 purchased, 1 canceled, 2 pending. */
export interface PlayProductPurchase {
  purchaseState?: number;
  consumptionState?: number;
  acknowledgementState?: number;
  obfuscatedExternalAccountId?: string;
  obfuscatedExternalProfileId?: string;
  purchaseTimeMillis?: string;
}

/** The Google Play Developer API calls Meldiq makes (a fake in tests). A purchase Google doesn't know answers null. */
export interface GooglePlayApi {
  getSubscription(token: string): Promise<PlaySubscription | null>;
  acknowledgeSubscription(productId: string, token: string): Promise<void>;
  getProduct(productId: string, token: string): Promise<PlayProductPurchase | null>;
  consumeProduct(productId: string, token: string): Promise<void>;
}

export class PlayApiError extends Error {
  constructor(readonly status: number) {
    super(`Google Play Developer API answered ${status}`);
  }
}

/** A service account's key (the JSON Google Cloud gives), kept on the server only. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type Fetch = typeof fetch;
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_LIFETIME_S = 3600;
/** Renew the access token this long before Google says it expires. */
const TOKEN_EARLY_MS = 60_000;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The Developer API over HTTPS with a service account (OAuth 2.0 JWT bearer grant). */
export class HttpGooglePlayApi implements GooglePlayApi {
  private access: { token: string; until: number } | null = null;

  constructor(
    private readonly packageName: string,
    private readonly key: ServiceAccountKey,
    private readonly fetchFn: Fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    const t = this.clock();
    if (this.access && this.access.until > t) return this.access.token;
    const iat = Math.floor(t / 1000);
    const aud = this.key.token_uri ?? DEFAULT_TOKEN_URI;
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: this.key.client_email, scope: SCOPE, aud, iat, exp: iat + TOKEN_LIFETIME_S }))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(this.key.private_key));
    const res = await this.fetchFn(aud, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(signature)}` }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new PlayApiError(res.status);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new PlayApiError(502);
    this.access = { token: body.access_token, until: t + (body.expires_in ?? TOKEN_LIFETIME_S) * 1000 - TOKEN_EARLY_MS };
    return body.access_token;
  }

  private async call<T>(method: "GET" | "POST", path: string): Promise<T | null> {
    const res = await this.fetchFn(`${API}/${encodeURIComponent(this.packageName)}/purchases/${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new PlayApiError(res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  getSubscription(token: string) {
    return this.call<PlaySubscription>("GET", `subscriptionsv2/tokens/${encodeURIComponent(token)}`);
  }

  async acknowledgeSubscription(productId: string, token: string) {
    await this.call("POST", `subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`);
  }

  getProduct(productId: string, token: string) {
    return this.call<PlayProductPurchase>("GET", `products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`);
  }

  async consumeProduct(productId: string, token: string) {
    await this.call("POST", `products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:consume`);
  }
}

/** A purchase token's stored and logged form: Google's raw token only ever goes back to Google. */
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * The opaque id the app passes to Google as `obfuscatedAccountId` (at most 64 characters, no personal data): an HMAC of
 * the account id under a server secret, so a purchase can be tied to the account that started it and to no other.
 */
export const accountToken = (secret: string, accountId: string): string => createHmac("sha256", secret).update(accountId).digest("base64url");

export const ACK_PENDING = "ACKNOWLEDGEMENT_STATE_PENDING";

/**
 * Google's subscription state in Meldiq's vocabulary (lifecycle.ts). In the grace period Google keeps the subscriber's
 * access while it retries the payment, so it maps to active; on hold, Google has taken access away.
 */
export function playStatus(state: string | undefined, expiresAt: number | null, t: number): { status: SubscriptionStatus; cancelAtPeriodEnd: boolean } {
  switch (state) {
    case "SUBSCRIPTION_STATE_ACTIVE":
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      return { status: "active", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_CANCELED":
      // Cancelled by the subscriber: paid for until the expiry, then over.
      return expiresAt !== null && expiresAt > t ? { status: "active", cancelAtPeriodEnd: true } : { status: "canceled", cancelAtPeriodEnd: true };
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return { status: "unpaid", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_PAUSED":
      return { status: "paused", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_EXPIRED":
      return { status: "canceled", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
      return { status: "incomplete_expired", cancelAtPeriodEnd: false };
    default:
      // SUBSCRIPTION_STATE_PENDING and anything newer: nothing is granted until Google says it's paid.
      return { status: "incomplete", cancelAtPeriodEnd: false };
  }
}

/** The line of [sub] that is one of Meldiq's subscription products, with what it is. */
export function playLine(sub: PlaySubscription): { productId: string; product: PlayProduct; expiresAt: number | null; autoRenew: boolean } | null {
  for (const l of sub.lineItems ?? []) {
    const product = l.productId ? playProduct(l.productId) : null;
    if (!product || product.kind === "gift") continue;
    const expiresAt = l.expiryTime ? Date.parse(l.expiryTime) : NaN;
    return { productId: l.productId!, product, expiresAt: Number.isNaN(expiresAt) ? null : expiresAt, autoRenew: l.autoRenewingPlan?.autoRenewEnabled ?? false };
  }
  return null;
}

/** A Google subscription as the subscription core reads it; its ref is the token's hash. */
export function playSnapshot(token: string, sub: PlaySubscription, t: number): SubscriptionSnapshot | null {
  const line = playLine(sub);
  if (!line) return null;
  const { status, cancelAtPeriodEnd } = playStatus(sub.subscriptionState, line.expiresAt, t);
  const start = sub.startTime ? Date.parse(sub.startTime) : NaN;
  return {
    ref: tokenHash(token),
    customerRef: null,
    status,
    priceRef: line.productId,
    checkoutRef: sub.externalAccountIdentifiers?.obfuscatedExternalProfileId ?? null,
    currentPeriodStart: Number.isNaN(start) ? null : start,
    currentPeriodEnd: line.expiresAt,
    trialEnd: null,
    cancelAtPeriodEnd: cancelAtPeriodEnd || (status === "active" && !line.autoRenew),
    canceledAt: status === "canceled" ? t : null,
    quantity: line.product.kind === "spark" ? line.product.quantity : 1,
  };
}

/** Google's signing keys for OIDC tokens (a fake in tests). */
export interface JwksSource {
  keys(refresh?: boolean): Promise<readonly (JsonWebKey & { kid?: string })[]>;
}

const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS_TTL_MS = 3_600_000;

export class GoogleJwks implements JwksSource {
  private cached: { keys: (JsonWebKey & { kid?: string })[]; until: number } | null = null;

  constructor(
    private readonly fetchFn: Fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async keys(refresh = false) {
    const t = this.clock();
    if (!refresh && this.cached && this.cached.until > t) return this.cached.keys;
    const res = await this.fetchFn(GOOGLE_CERTS, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new PlayApiError(res.status);
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    this.cached = { keys: body.keys ?? [], until: t + JWKS_TTL_MS };
    return this.cached.keys;
  }
}

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_S = 60;

/**
 * Checks the Bearer token Pub/Sub sends with a push: signed by Google (RS256, a current key), issued for our endpoint
 * ([audience]) to the push subscription's service account ([email], verified). Throws [WebhookRejected] otherwise.
 */
export async function verifyPushToken(authorization: string | undefined, expected: { audience: string; email: string }, jwks: JwksSource, t: number): Promise<void> {
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!m) throw new WebhookRejected("missing_signature");
  const [, h, p, s] = m as unknown as [string, string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: { iss?: string; aud?: string; exp?: number; iat?: number; email?: string; email_verified?: boolean };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    throw new WebhookRejected("unreadable_body");
  }
  if (header.alg !== "RS256" || !header.kid) throw new WebhookRejected("bad_signature");
  let key = (await jwks.keys()).find((k) => k.kid === header.kid);
  if (!key) key = (await jwks.keys(true)).find((k) => k.kid === header.kid);
  if (!key) throw new WebhookRejected("bad_signature");
  const valid = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey({ key, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!valid) throw new WebhookRejected("bad_signature");
  const now = Math.floor(t / 1000);
  if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss) || claims.aud !== expected.audience) throw new WebhookRejected("bad_signature");
  if (claims.email !== expected.email || claims.email_verified !== true) throw new WebhookRejected("bad_signature");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now || (claims.iat ?? 0) > now + CLOCK_SKEW_S) throw new WebhookRejected("stale_timestamp");
}

/** A real-time developer notification (the Pub/Sub message's data, base64 JSON). */
export interface PlayNotification {
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: { notificationType?: number; purchaseToken?: string; subscriptionId?: string };
  oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string };
  voidedPurchaseNotification?: { purchaseToken?: string; orderId?: string; productType?: number; refundType?: number };
  testNotification?: { version?: string };
}

/** The notification inside a Pub/Sub push body, or null when the body isn't one. */
export function parsePush(body: unknown): { messageId: string; notification: PlayNotification } | null {
  const msg = (body as { message?: { data?: unknown; messageId?: unknown; message_id?: unknown } } | null)?.message;
  const id = typeof msg?.messageId === "string" ? msg.messageId : typeof msg?.message_id === "string" ? msg.message_id : null;
  if (!msg || typeof msg.data !== "string" || !id) return null;
  try {
    return { messageId: id, notification: JSON.parse(Buffer.from(msg.data, "base64").toString("utf8")) as PlayNotification };
  } catch {
    return null;
  }
}
