import { z } from "zod/v4";
import { route, type RouteContract } from "../route.js";
import {
  Notice,
  NoticeBody,
  NoticeStateBody,
  Appeal,
  AppealBody,
  AppealDecision,
  Promotion,
  PromotionBody,
  Order,
  OpsId,
  OpsQuery,
  PolicyView,
  PolicyBody,
  Ownership,
  LegacyOperator,
} from "../operations.js";
const page = (item: z.ZodType) =>
  z.object({ items: z.array(item), next: z.string().nullable().optional() });
const item = (s: z.ZodType) => z.object({ item: s });
const id = z.object({ id: OpsId });
const ok = z.object({ ok: z.literal(true) });
const admin = (
  method: RouteContract["method"],
  path: string,
  summary: string,
  response: z.ZodType,
  body?: z.ZodType,
): RouteContract =>
  route({
    method,
    url: "/admin/v1/operations" + path,
    summary,
    tag: "Operational controls",
    auth: true,
    scheme: "console",
    requires: "admin_console",
    response,
    body,
  });
const user = (
  method: RouteContract["method"],
  path: string,
  summary: string,
  response: z.ZodType,
  body?: z.ZodType,
): RouteContract =>
  route({
    method,
    url: "/v2/" + path,
    summary,
    tag: "Platform operations",
    auth: true,
    response,
    body,
  });
const purchase = z.object({
  id: z.string(),
  itemId: z.string(),
  amountMinor: z.number(),
  currency: z.string(),
  status: z.string(),
  fulfillment: z.string(),
  url: z.string().nullable(),
  expiresAt: z.number(),
});
const capability = z.object({
  checkout: z.boolean(),
  refund: z.boolean(),
  provider: z.string().nullable(),
  mode: z.string().nullable(),
});
export const operationalControlRoutes: RouteContract[] = [
  admin("GET", "/notices", "Bounded announcement directory", page(Notice)),
  admin(
    "POST",
    "/notices",
    "Save an audited announcement draft",
    item(Notice),
    NoticeBody,
  ),
  admin(
    "POST",
    "/notices/:id/state",
    "Publish or withdraw using expected revision",
    item(Notice),
    NoticeStateBody,
  ),
  admin(
    "GET",
    "/notices/:id/receipts",
    "Actual unique read acknowledgements",
    z.object({ read: z.number() }),
  ),
  admin("GET", "/appeals", "Bounded appeal queue", page(Appeal)),
  admin(
    "POST",
    "/appeals/:id/decision",
    "Independent appeal decision and canonical warning revocation",
    item(Appeal),
    AppealDecision,
  ),
  admin(
    "GET",
    "/promotions",
    "Versioned Plus promotion directory",
    page(Promotion),
  ),
  admin(
    "PUT",
    "/promotions",
    "Create or change validated promotion availability",
    item(Promotion),
    PromotionBody,
  ),
  admin(
    "GET",
    "/policy",
    "Authoritative stable cohorts and upload policy",
    PolicyView,
  ),
  admin(
    "PUT",
    "/policy",
    "Atomically store and audit a versioned runtime policy",
    PolicyView,
    PolicyBody,
  ),
  admin(
    "GET",
    "/policy/history",
    "Stored complete policy revisions for rollback",
    page(PolicyView),
  ),
  admin(
    "GET",
    "/operators",
    "Legacy operator ceiling and current console reductions",
    page(LegacyOperator),
  ),
  admin(
    "PUT",
    "/operators/:id",
    "Reduce environment allowlisted legacy access",
    ok,
  ),
  admin(
    "GET",
    "/ownership",
    "Bounded owner-approval workflow directory",
    page(Ownership),
  ),
  admin(
    "POST",
    "/ownership",
    "Request existing-owner approval; never grants staff ownership",
    item(Ownership),
  ),
  admin(
    "GET",
    "/orders",
    "Verified collectible payments and durable fulfillment state",
    page(Order).extend({ capability }),
  ),
  admin(
    "POST",
    "/orders/:id/refund",
    "Audited idempotent provider refund",
    z.object({ status: z.string(), reference: z.string().nullable() }),
  ),
  admin(
    "POST",
    "/orders/reconcile",
    "Retry durable collectible fulfillment",
    ok,
  ),
  admin(
    "GET",
    "/warnings",
    "Canonical account standing and bounded warning history",
    z.object({
      standing: z.object({ level: z.string(), warnings: z.array(z.unknown()) }),
      items: z.array(
        z.object({
          id: z.string(),
          user_id: z.string(),
          reason: z.string(),
          created_at: z.number(),
          expires_at: z.number(),
          revoked_at: z.number().nullable(),
        }),
      ),
    }),
  ),
  admin(
    "POST",
    "/warnings",
    "Issue idempotent canonical standing warning with fresh MFA",
    z.object({
      id: z.string(),
      standing: z.object({ level: z.string(), warnings: z.array(z.unknown()) }),
    }),
  ),
  admin("POST", "/warnings/:id/revoke", "Lift an audited standing warning", ok),
  user(
    "GET",
    "platform/notices",
    "Active global or own notices; excludes other recipients",
    page(
      z.object({
        id: z.string(),
        title: z.string(),
        body: z.string(),
        kind: z.string(),
        startsAt: z.number(),
        endsAt: z.number().nullable(),
        read: z.boolean(),
      }),
    ),
  ),
  user(
    "POST",
    "platform/notices/:id/read",
    "Idempotent own notice acknowledgement",
    ok,
  ),
  user(
    "GET",
    "platform/appeals",
    "Own appeal history and decisions",
    page(Appeal),
  ),
  user(
    "POST",
    "platform/appeals",
    "Submit an own warning or account appeal",
    item(Appeal),
    AppealBody,
  ),
  user(
    "GET",
    "platform/features",
    "Effective server evaluated feature cohorts",
    z.object({
      version: z.number(),
      features: z.object({
        calls: z.boolean(),
        uploads: z.boolean(),
        orgCreation: z.boolean(),
      }),
    }),
  ),
  user(
    "POST",
    "platform/promotions/redeem",
    "Atomically redeem a real Plus entitlement once",
    z.object({ ok: z.literal(true), grantId: z.string() }),
  ),
  user(
    "GET",
    "platform/ownership",
    "Pending requests that the caller owns",
    page(Ownership),
  ),
  user(
    "POST",
    "platform/ownership/:id/approve",
    "Owner-confirmed member transfer through existing role rules",
    ok,
  ),
  user(
    "GET",
    "collectible-purchases",
    "Own frozen orders and provider capability",
    page(purchase).extend({ capability }),
  ),
  user(
    "POST",
    "collectible-purchases",
    "Server-priced hosted payment; does not grant ownership",
    purchase,
  ),
  user(
    "POST",
    "collectible-purchases/:id/confirm",
    "Verify provider capture and reconcile the owned purchase",
    purchase,
  ),
  route({
    method: "POST",
    url: "/v2/platform/appeals/email/start",
    tag: "Platform operations",
    auth: false,
    summary: "Nonenumerating email appeal proof, including suspended accounts",
    response: z.object({ challengeId: z.string(), message: z.string() }),
  }),
  route({
    method: "POST",
    url: "/v2/platform/appeals/email/complete",
    tag: "Platform operations",
    auth: false,
    summary: "Single-use email proof submits an appeal; cannot sign in",
    response: z.object({ id: z.string(), status: z.literal("open") }),
  }),
];
