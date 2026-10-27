# Billing: plans, subscriptions, entitlements and provider events (API 0.49.0)

Meldiq's subscription foundation. It is complete and tested end to end with a **sandbox provider (test mode, no
money)**. **No live payment provider is configured**: production runs with `BILLING_PROVIDER=none`, so nothing can be
bought. No prices, plans or quotas have been decided; none are invented here.

Code: `server/src/modules/billing/` (catalog, lifecycle, subscriptions, webhooks, metrics, providers), the console's
side in `server/src/modules/platformAdmin/billing.ts`, and the console pages in
`meldiq_central_admin/src/ui/pages/billing/`. Migration `061_billing.sql` (additive). Tests: `server/test/billing.test.ts`,
`meldiq_central_admin/e2e/billing.spec.ts`.

## The pieces, and who owns what

| Piece | Where | Source of truth |
|---|---|---|
| Plan catalog (versioned terms) | `billing_plans`, `billing_plan_versions` | Platform admins with `billing.manage` |
| Checkouts | `billing_checkouts` | Started by a community's **owner** |
| Subscriptions and their history | `billing_subscriptions`, `billing_subscription_history` | **Only** verified provider events |
| Invoices | `billing_invoices` | **Only** verified provider events |
| Provider events | `billing_provider_events`, `billing_webhook_rejections` | The provider's signed webhooks |
| Entitlements (limits) | `administration/entitlements.ts` | Overrides → plan → server → none (below) |
| Usage and quotas | `usage_daily` (`docs/USAGE_AND_PLANS.md`), the quota engine (`docs/QUOTAS.md`) | Measured by the server |
| Organization membership and roles | `org_members` | Unchanged; billing never edits it |

Billing belongs to an **organization** (community/workspace). The **billing owner** is the user who started the
checkout; only the organization's `OWNER` role may see billing (`GET /v1/orgs/:id/billing`) or start a checkout.
Members and admins see the plan's name and the limits (`GET /v1/orgs/:id/plan`), never invoices. Removing a member
never touches the subscription. Personal (per-user) plans don't exist and aren't modelled.

## Catalog and versions

- A plan has an internal `key` (never changes), a name, description, segment and a `public` flag.
- Terms are **versions**: interval (`month`/`year`), ISO 4217 currency, list price in the currency's **minor unit**
  (integer; never floating point), the provider's price id, trial days (0–365), grace days (0–60), and limits for the
  entitlement keys (`members`, `roles.custom`, `storage.bytes` in bytes).
- A draft may be edited. **Publishing** needs a configured provider and its price id (unique among published
  versions); it makes the draft what new subscribers get and retires the previous version for new subscribers.
- A published version is **immutable** (SQLite trigger `billing_plan_versions_frozen`). Every subscription keeps the
  version it is on: **editing the catalog never reprices anyone**. Moving existing subscribers to new terms is a change
  made at the provider (the provider's event then names the new price, which maps to the new version); there is no
  bulk repricing control.
- Archiving stops offering a plan; existing subscribers keep it until their subscriptions end at the provider.

## Lifecycle

States (provider vocabulary, `billing/lifecycle.ts`): `incomplete`, `trialing`, `active`, `past_due`, `paused`,
`canceled`, `incomplete_expired`. A scheduled cancellation is `active` (or `trialing`) with `cancel_at_period_end`.

| From | May become |
|---|---|
| (new) | any |
| incomplete | incomplete, trialing, active, past_due, incomplete_expired, canceled |
| trialing | trialing, active, past_due, paused, canceled |
| active | active, past_due, paused, canceled |
| past_due | past_due, active, paused, canceled |
| paused | paused, active, trialing, canceled |
| canceled, incomplete_expired | nothing (a new subscription is a new row) |

Anything else is refused (`invalid_transition`) and the event is kept as failed. The server never changes a state on
its own; every change comes from a verified provider event and is recorded in `billing_subscription_history`.

**Which states grant the plan** (one function, `grantsPlan`): `trialing` and `active` (including a scheduled
cancellation, since the period is paid for); `past_due` during the version's grace days counted from the first failed
payment (`past_due_since`); nothing else. When the plan stops applying, the organization falls back to operator or
server limits. **Nothing is deleted or hidden**: limits only refuse adding more (members, roles, uploads); downloads,
existing files and members stay.

Flows: start (owner's checkout → provider event creates the row), trial start and end, first payment, renewal (period
moves on), payment failure and retries (`past_due` + grace), upgrade/downgrade (a new price → another version, applied
when the provider says it takes effect), cancel at period end and reactivation (the flag), cancellation and expiry,
reconciliation (replay below). Refunds are recorded as amounts on invoices; there is no refund control here.

## Entitlement precedence

`Entitlements.limitFor(key, orgId)`: the first layer with a value decides.

1. **Operator limit** for this organization (`org_entitlements`), while not expired. Set in the console with a reason
   and an end date within 366 days; only a super admin may set one with no end. Used for support exceptions and abuse
   restrictions. Rows set before 0.49.0 have no end date and keep applying.
2. **The plan** of the organization's subscription, while it grants one.
3. **Server-wide** `ENTITLEMENT_LIMITS`.
4. None (unlimited).

Account security, recovery, data export, leaving, deleting and cancelling are never limited. Enforcement is
server-side where things are added (invites and joins, direct adds, applications, custom roles, Discord import, file
uploads). Uploads reserve their size under the quota lock before reading the body, so parallel uploads can't overshoot
the stored-bytes limit (`files/routes.ts`); member and role checks run inside SQLite's single writer.

## Checkout

`POST /v1/orgs/:orgId/billing/checkout { planKey }` (owner only): the plan must be public, active and current at the
configured provider; the organization must have no subscription that isn't over. The server records a checkout
(`chk_…`, 24 hours) and asks the provider for a hosted page, passing the checkout id as the reference. **Coming back
from the provider's page proves nothing**: the subscription exists only once the provider's signed event arrives
naming that checkout. A provider event can attach a subscription to an organization **only** through such a checkout,
never through an organization id it sends. No card or bank data ever reaches Meldiq.

## Webhooks

`POST /v1/billing/webhooks/:provider` (no session; 256 KB body limit; only the configured provider's path exists,
others answer 404).

1. The signature is checked against the body exactly as received. Sandbox: header
   `meldiq-sandbox-signature: t=<unix s>,v1=<hex HMAC-SHA256("<t>.<body>")>`, accepted within 5 minutes. Refusals
   answer 400 and are counted per day and reason (`billing_webhook_rejections`); nothing from the body is trusted.
2. The event is stored once per provider event id (`UNIQUE(provider, event_ref)`), with a minimal normalized summary
   (references, states, amounts; never card details). A repeat is acknowledged (`duplicate: true`) and not applied.
3. It is applied in one transaction. Subscription events are **snapshots**: one older than the newest applied
   (`provider_updated_at`) is `ignored`, so duplicates and out-of-order deliveries settle on the latest state.
4. A failure keeps the event as `failed` with its reason (`unknown_price`, `unknown_checkout`, `unknown_subscription`,
   `invalid_transition`, `org_has_subscription`, `checkout_mismatch`, `internal_error`). The cleanup job retries due
   events every minute with backoff (1 min doubling, at most 6 h); after 8 attempts the event is `dead`.
5. The answer is 200 once the event is stored, whatever applying did: the provider never needs to resend it.

An invoice that arrives before its subscription fails with `unknown_subscription` and is applied on a later retry.

## Console (`/admin/v1/billing/…`)

| Route | Permission | |
|---|---|---|
| `GET /admin/v1/billing/metrics?days=7\|30\|90` | `billing.view` | figures below, with definitions and the provider's setup |
| `GET /admin/v1/billing/plans` | `billing.view` | plans, versions (draft/current/retired) and subscriber counts per version |
| `POST /admin/v1/billing/plans` · `PATCH …/:planId` · `PUT …/:planId/draft` · `POST …/:planId/publish` · `POST …/:planId/archive` | `billing.manage` ★ | create (with the first draft), details, draft terms, publish, archive |
| `GET /admin/v1/billing/subscriptions?status=&plan=&org=&cursor=&limit=` | `billing.view` | keyset-paged, at most 100 a page |
| `GET /admin/v1/billing/subscriptions/:id` | `billing.view` | state, terms, provider references, history, invoices, limits, events (50 each) |
| `GET /admin/v1/billing/events?status=&cursor=&limit=` | `billing.view` | verified provider events and what became of them |
| `POST /admin/v1/billing/events/:id/replay` | `billing.events.replay` ★ | apply a failed or dead event again |
| `PUT /admin/v1/orgs/:orgId/limits` | `entitlements.edit` ★ | `{ limits, expiresAt, reason }`: operator limits with an end date |

★ = a fresh passkey check and a written reason; audited (`billing.plan_create`, `billing.plan_update`,
`billing.plan_draft`, `billing.plan_publish`, `billing.plan_archive`, `billing.event_replay`, `org.limits`).

Roles: `billing_admin` and `super_admin` have all three billing permissions; `support_admin` and `auditor` have
`billing.view`; `operations_admin` has none. There is **no "force paid" control** and no manual state edit: correcting
a subscription means fixing the cause (a missing price, a plan version) and replaying the provider's event.

## Metrics

Money is summed **per currency** in minor units, never converted. Windows end now, in UTC.

| Figure | Definition | Kind |
|---|---|---|
| Subscriptions by state | current state of every subscription | measured |
| Granting a plan | trialing, active, or past due within grace | calculated |
| MRR estimate (list price) | list prices of subscriptions granting a plan, trials excluded, yearly ÷ 12 (summed first, then divided); no discounts, tax or prorations, so **not recognised revenue** | estimate |
| Collected payments | amount paid on invoices marked paid, by payment time in the window (cash, not revenue) | measured |
| Refunds recorded | refunded amounts on invoices updated in the window (refund time isn't kept) | measured |
| Outstanding | due minus paid on open and payment-failed invoices, now | calculated |
| Failed payments | invoices whose latest state is payment failed, updated in the window | measured |
| New subscriptions · Cancellations | first seen · moved to canceled, in the window | measured |
| Trial conversions | trialing → active in the window, out of trials that ended in it | calculated |
| Logo churn | of subscriptions active or past due at the window's start, the share canceled since; null when none | calculated |
| Provider events | verified events by processing state, refusals by reason, backlog and its age | measured |

Not shown because the data can't support them: ARR beyond the MRR estimate, LTV, CAC, net/gross revenue retention,
profit, tax figures. The Overview's Billing card says whether a provider is connected and points here; it never shows
revenue.

## Settings

| Variable | Default | |
|---|---|---|
| `BILLING_PROVIDER` | `none` | `none`: no checkout, no webhook route; plans can be drafted but not published. `sandbox`: test mode |
| `BILLING_SANDBOX_WEBHOOK_SECRET` | unset | with `sandbox`: at least 32 characters; the server refuses to start otherwise |

`deploy/scripts/validate-env.sh` checks both and warns that sandbox is test mode. Never commit secrets.

## Adding a live provider (the remaining external step)

1. Choose the provider (the owner's decision: availability in the business's country, currencies, tax handling,
   hosted checkout and customer portal, and whether Google Play billing rules apply to the Android distribution).
2. Implement `BillingProvider` (`billing/providers/types.ts`): `verifyWebhook` with the provider's own signature scheme
   and replay window, mapping its subscription and invoice objects to `SubscriptionSnapshot`/`InvoiceSnapshot`
   (states mapped onto the table above), and `createCheckout` passing our checkout id as the reference the provider
   echoes back. Add it to `billing/config.ts` with its secrets, and to `validate-env.sh`.
3. Test with the provider's test mode end to end (checkout, renewal, failed payment, cancellation, duplicate and
   out-of-order webhooks) before any live key is set.
4. Create the prices at the provider, draft the plans in the console with those price ids, publish.

Tax, invoice numbering and legal terms are the provider's and the owner's: nothing here produces a tax invoice.

## Runbooks

- **Webhooks refused** (Overview › Provider webhooks › Refused): a wrong or rotated secret, or someone probing the
  endpoint. Compare the secret with the provider's dashboard; rotation means updating `.env` and recreating the API.
- **Events failing**: open Provider events, filter Failed/Gave up. `unknown_price`: publish a plan version with that
  provider price, then Replay. `unknown_checkout`: a subscription created outside Meldiq's checkout; it can't be
  attached to an organization automatically (by design), contact the customer. `invalid_transition`: compare with the
  provider's dashboard; a newer snapshot usually settles it.
- **Provider outage**: events queue at the provider and arrive later; snapshots make the order irrelevant. The backlog
  and the age of the oldest event are on the Overview.
- **Quota dispute**: the subscription page shows which layer each limit comes from (operator, plan, server) and the
  history; operator limits always carry their reason and end date in the audit trail.
- **Inconsistent state**: never edit rows. Find the provider's latest event for the subscription; if it was missed,
  have the provider resend it (same event id is safe) or replay the stored one.

## Rollback

Migration 061 only adds tables and two nullable columns; API 0.47.0 runs on it unchanged (it ignores them). Rolling
back the image leaves billing rows in place, unread.
