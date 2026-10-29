# Free, Go and Plus (API 0.66.0, 2026-10-30)

The owner's plan spec of 2026-10-30, applied to Meldiq Mojo (docs/MOJO.md, docs/BILLING.md). Branch `plans-v2` (from
`settings-parity` 0.65.0), web `landing-plans` (from `floating-redesign`), console 1.4.0. **Not deployed.**

## The plans

| | Free | Mojo Go | Mojo Plus |
|---|---:|---:|---:|
| Price a month (list; a checkout charges the published catalog price) | $0 | $1.99 | $4.99 |
| Characters in a message or edit | 2,000 | 4,000 | 8,000 |
| Largest single file | 50 MB | 500 MB | 2 GB |
| Screen sharing, up to | 720p 60 fps | 1080p 60 fps | 2K (1440p) 60 fps |
| Custom emoji and stickers added (one pool) | 20 | 50 | 250 |
| Bots owned | 2 | 4 | 10 |
| Badge | none | Go | Plus (+ Meldiq Check) |
| Sparks included (unchanged, not in the spec) | 0 | 1 | 2 |

Code: `server/src/modules/billing/perks.ts` (`CATALOG_VERSION` 2026-10-30.1). Every client reads it from
`GET /v2/mojo/catalog` (public, no account), and every limit is worked out on the server from verified billing only
(`billing/mojo.ts`, `billing/entitlements.ts`): one authoritative answer for the API, the web, Android and the console.
Meldiq Spark (community boosts) and its levels are unchanged and stay a separate purchase with its own rules.

## What was there before, and the conflicts

| Spec | Before (0.65.0) | Resolution |
|---|---|---|
| Free/Go/Plus | Free, "Mojo Go", "Mojo Plus" | Kept the Mojo names (brand, Stripe products, apps); badges are "Go" and "Plus" as specified |
| $1.99 / $4.99 | $0.99 / $3.99 | Changed. Stripe never had live subscribers (billing off), so nobody is repriced |
| 2,000 / 4,000 / 8,000 characters | 1,000 / 2,000 / 5,000 | Changed |
| 50 MB / 500 MB / 2 GB | 50 MB / 200 MB / 2 GB | Changed. **Production advertised 2 GB for Plus but accepted 1 GiB** (`FILE_MAX_BYTES`): plans now never offer more than the server takes, and the default is 2 GB |
| 720p60 / 1080p60 / 1440p60 | 720p30 / 720p60 or 1080p30 / 1080p60 or 1440p30 | Changed; new preset `1440p60`. One ceiling per plan covers every smaller share |
| 20 / 50 / 250 custom items | same | — |
| 2 / 4 / 10 bots | same numbers; docs said "bots not built" | Bots exist since 0.65.0 and were limited at creation only: **a downgrade kept every bot working**. Now the newest bots beyond the plan are locked (`403 bot_locked`), nothing deleted |
| Editable prices and limits | limits for 4 numbers; prices not editable | Bots and the screen ceiling are editable; prices have their own audited route that reaches Stripe |
| Spark rules separate | — | Untouched. Note: Spark Level 1's 720p 30 screen perk is now below Free's own 720p 60, so it adds nothing for screen sharing (the owner may want to revisit Spark levels) |

## How each limit is enforced (and what can't be)

| Limit | Enforced by | Limits of enforcement |
|---|---|---|
| Characters | Server counts grapheme clusters on `POST /v2/messages` (plain messages, edits, bots) → `413 message_too_long`. Old encrypted `/v1` path: a ciphertext size bound | Exact on the server for server-stored messages |
| File size | Server, before any byte is read, both upload paths → `413 upload_limit`; never above `FILE_MAX_BYTES` | Exact |
| Screen sharing | Server sends each person's ceiling with the call grant (`media.limits.screen`); LiveKit's `track_published` webhook reports the resolution and the server **mutes** a share above the ceiling | **Frame rate isn't reported by LiveKit**: 60 fps is kept by the apps (the web caps capture and encoder at the plan's rate). A modified client could send 1440p at more than 60 fps; it can't send more pixels than its plan |
| Custom emoji and stickers | Server on add; over a limit the newest are locked | Exact |
| Bots | Server on create; beyond the plan the newest are locked at token auth | Exact |
| Badge | Server computes it from verified billing for member lists and profiles | Exact |
| Everything | Only while plan limits are enforced: console › Mojo › "Plan limits apply" (`MOJO_ENFORCE`, default auto: on once Go/Plus are on sale) | Production today: nothing on sale, so plan limits don't apply yet |

**What LiveKit and the apps can actually deliver.** The web shares at 2K 60 with a 12 Mbps ceiling and steps down
under bandwidth or CPU pressure (`call/shareQuality.ts`): 1440p60 is a ceiling, not a promise; the sharer's screen,
GPU and upload decide what is sent. The Android app reads the presets from the catalog; it has no 2K 60 encoder
setting of its own yet (follow-up). The landing page and plan cards therefore say "up to".

## Stripe

Already in place before this change and covered by tests: checkout only for a published plan (the client names a key,
never a price), one open checkout per owner (an older one is expired), verified webhooks (signature, 5-minute
tolerance), each event stored once by its Stripe id before it's applied (duplicates acknowledged and skipped),
transactional apply with retries and dead-lettering, renewals from `invoice.paid`, failed payments → past due with the
grace days from the console's site details, cancellation at the period's end, refunds and disputes recorded,
reconciliation by reading Stripe.

Added here:

- **Upgrades are invoiced at once** (`proration_behavior: always_invoice`): an upgrade can't be used and cancelled
  before the difference is ever charged. **Downgrades wait for the period's end** (`schedule_at_period_end` on a
  decreasing amount): the plan already paid for is kept until then.
- **Price changes** (console › Mojo › Change prices, `PUT /admin/v1/billing/mojo/prices`): new Stripe prices take the
  lookup keys, the old ones are archived (subscribers keep paying them; Stripe never reprices a subscription), the
  portal switches, and new catalog versions are published. Bounds $0.50–$99.99, Plus must cost more than Go.
- `stripe-setup` keeps the catalog's published prices on a rerun; `--list-prices` sells at the built-in ones.
- **Discrepancies** (console › subscription › Compare with the payment provider): Meldiq's record beside Stripe's,
  read now; "Apply the provider's state" re-applies it (audited, `billing.manage`, reason).

Downgrade loopholes closed: bots (above); everything else was already worked out per request (files kept, items and
Sparks over a limit locked, badges and limits follow the plan at once). A refund keeps access to the period's end (a
business decision recorded in docs/MOJO.md).

## Console (1.4.0)

Revenue & Billing › Meldiq Mojo: limits per plan including bots and the screen ceiling, enforcement, prices (list and
charged), figures. Subscriptions, payment events with replay, failed payments and cancellations, free periods (the
audited manual entitlement adjustments), gifts and Sparks were already there. Roles: `billing.view` reads
(super_admin, billing_admin, support_admin, auditor); `billing.manage` changes (super_admin, billing_admin) with a
recent passkey check and a written reason; every change is in the hash-chained audit log. Stripe keys and the webhook
secret exist only in the API's `.env`: no console page or admin answer shows them.

## Cost estimate (before calling the plans profitable)

Figures are list prices and assumptions, not measurements. The console's Traffic & Costs page holds the real ones
once its cost settings are filled in.

**Revenue after Stripe** (2.9% + $0.30 a charge, US card; international cards about 2.5% more):

| | Go $1.99 | Plus $4.99 |
|---|---:|---:|
| Stripe fee | $0.36 (18%) | $0.45 (9%) |
| Net a month | **$1.63** | **$4.54** |

The fixed $0.30 makes Go the weaker plan: a yearly Go price would keep more.

**Storage** (S3 Singapore $0.025 per GB-month; files are kept 7 days, or 365 days in kept history): a 2 GB file kept a
year costs $0.60, about $0.05 a month. Storage isn't the risk.

**File downloads** (S3 data out $0.12 per GB after the account's free 100 GB a month): one file × the people who
open it. A Go member sharing a 500 MB clip that 10 people open costs $0.60; a Plus member's 2 GB file opened by 10
costs $2.40. Break-even is about **13 GB downloaded per Go subscriber** and **38 GB per Plus subscriber** a month, and
every Free member's downloads are paid by them too.

**Screen sharing and calls** (LiveKit on the VPS; each viewer receives the stream):

| Ceiling | Top bitrate | Per viewer-hour |
|---|---:|---:|
| Free 720p 60 | 3.5 Mbps | 1.6 GB |
| Go 1080p 60 | 6 Mbps | 2.7 GB |
| Plus 1440p 60 | 12 Mbps | 5.4 GB |

On the Hostinger VPS this traffic is inside the plan's monthly transfer allowance (check it in hPanel), so it costs
capacity, not money: one 1 Gbps port carries about 80 viewers of 1440p60 at once, before CPU. **On metered egress it
would not be profitable**: at $0.12 per GB one Plus member streaming 1440p60 to 5 friends for 2 hours costs about
$6.50, more than a month of Plus.

**Conclusion.** The plans can be profitable only while media stays on a flat-rate server and file downloads per
subscriber stay below the break-even above. Before calling them profitable: fill in the console's cost settings,
watch S3 data out and the VPS transfer for a month, and consider storage without egress fees (for example Cloudflare
R2) for files.

## Migration and rollback

No database migration: plan numbers live in code, operators' changes in `mojo_controls` (JSON; new keys `bots`,
`screen`, `listPriceMinor`), and prices in new published catalog versions. Backward compatible: old Android builds
read preset ids as strings; the web before `landing-plans` refuses a catalog with `1440p60` (strict enum), so **ship
the web first**.

1. Web `landing-plans` (accepts `1440p60`, the landing page, 2K 60 sharing).
2. API 0.66.0. `.env`: `FILE_MAX_BYTES=2000000000` (production pins 1073741824; drop any `ATTACHMENT_MAX_BYTES` pin).
   With `STORAGE_BACKEND=local`, nginx's `client_max_body_size` must allow it too (S3 uploads go straight to the bucket).
3. Console 1.4.0.
4. Billing (owner): `bash deploy/scripts/stripe-setup.sh --live --replace-webhook --list-prices` once, so Stripe sells
   at $1.99 / $4.99 and the live leftovers of 2026-10-29 are archived. After that the console changes prices.
5. When ready: console › Mojo › "Plan limits apply" (or it follows automatically once Go/Plus are on sale).

Rollback: the API image `0.65.0-rollback`. **Before rolling back**, reset the console's Mojo limits (leave bots and
screen at their built-in values and save) and prices, because 0.65.0 doesn't know the new override keys. Stripe prices
made in the meantime stay archived or active at Stripe; nothing is deleted.

## Open issues

- **History keeps at most 1 GiB per person** (`HISTORY_MAX_BYTES_PER_USER`): a 2 GB file can be shared, but it isn't
  kept in history beyond the 7-day relay. Raise it, or decide that's intended.
- Android has no 2K 60 share setting yet; it offers the presets it knows.
- The marketing site (meldiq.app, `meldiq_landing_website`) has its own pricing page; check that it reads the catalog
  rather than old prices.
- Visitors can't browse public communities without an account (`/v1/communities/discover` needs one). A public,
  read-only directory would make the landing page's Explore richer; it needs a privacy decision.
- The Stripe end-to-end test against test mode (`server/test/billing_stripe_e2e.test.ts`) still needs a `sk_test_`
  key and has never run.

---

## Earlier: the preparation note of 2026-10-19

Since API 0.49.0 (2026-10-28) plans, subscriptions and provider events exist: see `BILLING.md`. The original note:
Meldiq was meant to launch with Free and Premium options before any plans, prices or entitlements were decided; that
round added `server/src/entitlements.ts` (countable workspace capabilities, operator limits through
`ENTITLEMENT_LIMITS`, `GET /v1/orgs/:id/plan`). Never gated by a plan: account security, recovery, data export,
leaving or deleting, and cancelling. Comparisons must be factual (no invented reference prices, no urgency or guilt
copy).
