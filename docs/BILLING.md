# Billing: plans, subscriptions, entitlements and provider events (API 0.49.0, Stripe and personal plans 0.52.0)

> **API 0.52.0 (2026-10-28, in production since 07:19 UTC with `BILLING_PROVIDER=none`):** Stripe as a provider, subscriptions owned by a person's account as well
> as by an organization, one provider customer per owner, the `unpaid` state, and the one entitlements API every client
> reads. See [Meldiq Mojo and Stripe (0.52.0)](#meldiq-mojo-and-stripe-0520) at the end; the sections before it describe
> the 0.49.0 foundation, which is unchanged where that section doesn't say otherwise.

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

## Meldiq Mojo and Stripe (0.52.0)

Code: `billing/providers/stripe.ts`, `billing/owners.ts`, `billing/entitlements.ts`, the v2 routes in `billing/routes.ts`;
migration `062_billing_owners.sql`; tests `server/test/billing_stripe.test.ts` (Stripe in test mode against a recording
fake of Stripe's API, webhooks signed and verified with the official SDK; a test store adapter). The website that sells
it is `meldiq_landing_website` (meldiq.app).

### The product (owner, 2026-10-28)

The paid offering is called **Meldiq Mojo** in every client and page, never "premium" or "paid version". Two personal
plans, monthly, USD; no organization plans:

| Console field | Mojo Go | Mojo Plus |
|---|---|---|
| key | `go` | `plus` |
| name | `Mojo Go` | `Mojo Plus` |
| audience | `personal` | `personal` |
| public | yes | yes |
| interval · currency · amountMinor | month · USD · `99` | month · USD · `399` |
| providerPriceRef | the Stripe Price id (`price_…`) of a $0.99/month recurring price | of a $3.99/month price |
| trialDays · graceDays | **owner decision pending** (0 until decided) | **pending** |
| limits · quotaPlanId | **pending**: what each plan includes isn't decided | **pending** |

Create them in the console (Billing › Plans) once the Stripe prices exist; publishing needs `BILLING_PROVIDER=stripe`.
Until then `GET /v2/billing/plans` answers an empty list and the website shows the prices as "not on sale yet".

### Owners

A subscription, checkout, invoice or provider customer belongs to an **owner** (`owner_kind`):

- `account`: a person's account (`accounts.id`, the permanent sign-in identity every client signs in to). Not
  `users.id`: an account can buy on the website before it has an encryption identity. `owner_user_id` records that
  identity once known (at checkout, and on every v2 billing request), for the quota engine.
- `org`: an organization (community). Unchanged from 0.49.0; its OWNER role manages it, its members get its plan.

A plan's `audience` (`personal` | `organization`, fixed at creation) decides which owners may buy it. The owner of a
checkout comes from the signed-in session only; the owner of a subscription only from our own checkout id echoed by the
provider (`metadata.meldiq_checkout`), never from a customer id, an owner id in metadata, or an email.

### Stripe

| Setting | |
|---|---|
| `BILLING_PROVIDER=stripe` | |
| `STRIPE_SECRET_KEY` | `sk_test_…`/`rk_test_…`. A live key is refused unless `BILLING_ALLOW_LIVE=true` and `APP_ENV=production` |
| `STRIPE_WEBHOOK_SECRET` | the endpoint's `whsec_…` |
| `BILLING_RETURN_URL` | where Checkout and the portal send people back: `https://meldiq.app/account/billing` (https, no query) |
| `STRIPE_ALLOW_PROMOTION_CODES` | `false` by default |

- **Checkout** (Stripe-hosted, `mode: subscription`): one Stripe customer per owner, created before the first checkout
  with the account's verified email (idempotency key per owner) and reused; `client_reference_id` and
  `subscription_data.metadata.meldiq_checkout` carry our checkout id; the price is the catalog's, never the client's; a
  trial only on the owner's first subscription. Starting a new checkout supersedes (and expires at Stripe) the owner's
  unfinished one, so two payment pages can't both become subscriptions. Success and cancel URLs are fixed by
  `BILLING_RETURN_URL`.
- **Webhooks** (`POST /v1/billing/webhooks/stripe`): verified by `stripe.webhooks.constructEvent` against the raw body
  (5-minute tolerance), stored once per event id, applied in one transaction. Events to enable in the Stripe Dashboard:
  `customer.subscription.created|updated|deleted|paused|resumed|trial_will_end|pending_update_applied|pending_update_expired`,
  `invoice.finalized|paid|payment_succeeded|payment_failed|payment_action_required|voided|marked_uncollectible|updated`,
  `checkout.session.completed|async_payment_succeeded|async_payment_failed|expired`, `charge.refunded`,
  `charge.dispute.created|closed` (`STRIPE_WEBHOOK_EVENTS`).
- **Mapping** (API version `2026-09-30.endive`, pinned by stripe 23.0.0): periods from the subscription item; an
  invoice's subscription from `parent.subscription_details`; `cancel_at` counts as ending; drafts aren't recorded.
- **Ordering:** Stripe stamps events to the second. A snapshot older than the newest applied is ignored; one from the
  same second that would move backwards (created after updated) is ignored too.
- **Reconciliation:** `checkout.session.completed` naming a subscription Meldiq hasn't seen makes the server read it
  from Stripe at once; `POST /v2/billing/sync` (the website calls it on return from Checkout) reads the owner's live
  subscription and those its own completed checkouts created, nothing a client names.
- **Refunds and disputes** are written into the subscription's history (`detail.refund` / `detail.dispute`); they don't
  change access by themselves: if Stripe cancels the subscription, that event does. Whether a refund should end access
  at once is a **business decision** (today: no).
- **Customer portal** (`POST /v2/billing/portal`): only for the owner's stored customer; returns to `BILLING_RETURN_URL`.
  Configure it in the Stripe Dashboard (below).

### Entitlements API (every client)

`GET /v2/billing/entitlements` with any v2 access token (website: no device; apps: device-bound, same token):

```json
{ "accountId": "acc_…", "billing": { "available": true, "mode": "test" },
  "personal": { "plan": { "key": "plus", "name": "Mojo Plus" }, "standing": "entitled", "accessUntil": 1795761176000,
                "renews": true, "quotaPlanId": null, "subscription": { "status": "active", "provider": "stripe", … } },
  "organizations": [ … ], "revision": "4f1c…", "evaluatedAt": 1793170000000 }
```

- Computed on the server from verified subscriptions (any provider) and current memberships. Signing in grants
  nothing; no client value (plan name, flag, receipt) is an input. `standing`: `none` (free), `entitled`, `grace`
  (payment failing, plan still applies until `accessUntil`), `grace_ended`, `not_entitled`.
- The same account gets the same answer on every device; `revision` changes whenever the answer does.
- **Refresh:** at sign-in and app start, on return to the foreground, and on the realtime frame
  `{ "t": "entitlements.changed", "scope": "account" | "org", "orgId"? }` (sent to the account's devices or the
  organization's members when a subscription changes). On sign-out or account switch, drop the cached answer.
- **Enforcement stays on the server** (organization limits, the quota plan a subscription grants). A client may hide or
  show things from this answer, never decide access on its own.
- Other v2 routes: `GET /v2/billing/plans` (public), `GET /v2/billing/account`, `GET /v2/billing/orgs/:orgId` (owners),
  `POST /v2/billing/checkout {planKey, orgId?}`, `/portal {orgId?}`, `/sync {orgId?}` (10 a minute).

### Store billing: Google Play (API 0.55.0)

The Android app sells through Google Play (docs/MOJO_ANDROID.md): `billing/play.ts` sits beside the provider above
(Stripe keeps its routes and webhooks unchanged). Play purchases are read from the Google Play Developer API and applied
through the same subscription core (`provider: "google_play"`, the token's hash as the subscription ref) and gift rules;
the Android app never links to the website's checkout. Apple StoreKit would follow the same pattern.

### Stripe Dashboard setup (owner; can't be done from here)

1. Test mode first. Create product **Meldiq Mojo** with two recurring monthly USD prices: Mojo Go $0.99, Mojo Plus $3.99.
2. Webhook endpoint `https://msg.meldiq.app/v1/billing/webhooks/stripe` with the events above; copy its `whsec_…`.
3. Customer portal: allow updating payment methods, invoice history, cancellation at period end, and (optional)
   switching between the two prices.
4. Tax (Stripe Tax or none), statement descriptor, business details, receipts emails: owner's choices.
5. API `.env`: the settings above; `bash deploy/scripts/validate-env.sh`; restart the API; create and publish the two
   plans in the console with the price ids.
6. Test with Stripe test cards end to end (subscribe, renew with a test clock, failed payment, cancel, portal) before
   any live key.

### Account deletion

`DELETE /v2/account` answers `409 subscription_active` while the account's own subscription still renews (deleting the
account wouldn't stop Stripe charging it). Billing rows aren't deleted with the account (accounting).

### Rollback

Migration 062 rebuilds `billing_checkouts`, `billing_subscriptions` and `billing_invoices` with every 0.49.0 column
kept (`org_id` only becomes nullable) and adds `billing_customers` and two nullable columns: API 0.51.1 runs on it and
ignores personal rows. Roll back the image as usual; `BILLING_PROVIDER=none` stops all buying at once.

## Trials and invite links (0.53.0, owner's decisions 2026-10-28)

Free Meldiq Mojo periods with no payment provider involved: `billing/grants.ts`, migration `063_billing_grants.sql`,
tests `server/test/billing_trials.test.ts`.

| Rule | Setting (default) |
|---|---|
| Trials on from a moment (unset: off) | `BILLING_TRIAL_STARTS_AT` (ISO time) |
| The plan a free period gives | `BILLING_TRIAL_PLAN` (`plus`: Mojo Plus) |
| Every account's trial: 14 days from sign-up, or from `BILLING_TRIAL_STARTS_AT` for older accounts | `BILLING_TRIAL_DAYS` (14) |
| Through someone's invite link: the new account gets 30 days (from sign-up, instead of 14), and so does the inviter | `BILLING_REFERRAL_DAYS` (30) |
| Each invite adds 30 days to the inviter, up to 90 days in any 365 | `BILLING_REFERRAL_YEARLY_CAP_DAYS` (90) |
| An invite link counts only for an account at most this old, once per account, never one's own | `BILLING_REFERRAL_CLAIM_DAYS` (7) |

- A grant is "this account has this plan until then": the entitlements answer it like a subscription that doesn't
  renew (`personal.trial: { source: signup | invite | invite_bonus, endsAt }`), and it puts the person on the plan's
  quota plan. No card, nothing charged, nothing renews.
- The trial is recorded the first time the account reads its entitlements or billing page (with its sign-up time, so
  reading late doesn't extend it). Inviter bonus days follow on from the inviter's latest grant.
- Subscribing during a free period: Stripe Checkout gets `subscription_data.trial_end` = the period's end (if more than
  two days are left), so the first payment is taken then.
- Routes: `GET /v2/billing/referral` (code, invited, bonus days this year, cap), `POST /v2/billing/referral/claim
  { code }` (10 a minute). Invite links: `https://meldiq.app/signup?ref=<code>`; the website claims it after the new
  account verifies its address and signs in.
- Abuse limits: verified email needed to sign in at all; one invite per account; 7-day window; the inviter's yearly cap.
  Operators can see referrals in `billing_referrals` (audit action `billing.referral`).

## Stripe setup (one command, test mode)

Needs API 0.53.0 or later in production. From the `meldiq_android` folder on your Mac:

```bash
bash deploy/scripts/stripe-setup.sh
```

It asks for the Stripe **test** secret key (hidden), and on the server: backs `.env` up, stores the key, runs
`admin.js stripe-setup` (creates or finds the Meldiq Mojo product, the $0.99 and $3.99 monthly USD prices with lookup
keys `meldiq_mojo_go_monthly` / `meldiq_mojo_plus_monthly`, the webhook endpoint
`https://msg.meldiq.app/v1/billing/webhooks/stripe` and a customer portal configuration), writes
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION`, `BILLING_RETURN_URL` and `BILLING_PROVIDER=stripe`, restarts the
API (restoring the backup if it doesn't come back healthy), publishes Mojo Go and Mojo Plus (`admin.js
billing-mojo-plans`), and prints the public price list. No secret is ever printed. Live keys are refused. Run it again
safely; `--replace-webhook` makes a new signing secret if the old one was lost. Tax: none collected (owner's decision).
