# Meldiq Mojo, Meldiq Spark and gifts (API 0.54.0, 2026-10-28)

Meldiq's paid plans are called **Meldiq Mojo** (docs/BILLING.md › Meldiq Mojo and Stripe). This release turns the
owner's finalized plan matrix into real limits, adds **Meldiq Spark** (server boosts with three levels) and **gifts**.
All of it lives in the billing domain, which since this release can live in MongoDB (`MONGODB_DOMAINS=…,billing`,
docs/MONGODB.md).

Code: `server/src/modules/billing/perks.ts` (the one catalog), `mojo.ts` (plans, Sparks, levels, badges), `gifts.ts`,
`mojoRoutes.ts`; enforcement in `files/routes.ts`, `messaging/messagesRoutes.ts`, `organizations/expressionsRoutes.ts`,
`calls/routes.ts` and `accounts/profile.ts`. Migration `064_mojo_perks.sql` (the schema the rows layer reads; additive).
Tests: `server/test/mojo.test.ts` (on SQLite and with billing in MongoDB).

## Plans

| | Free | Mojo Go | Mojo Plus |
|---|---:|---:|---:|
| Price (list) | $0 | $0.99 / month | $3.99 / month |
| Characters in one message or edit | 1,000 | 2,000 | 5,000 |
| Largest single file | 50 MB | 200 MB | 2 GB |
| Screen sharing | 720p 30 fps | 720p 60 fps or 1080p 30 fps | 1080p 60 fps or 2K (2560×1440) 30 fps |
| Meldiq Sparks included | 0 | 1 | 2 |
| Name badge | none | Go | Plus (hide it any time) |
| Meldiq Check | no | no | yes |
| Custom emoji and stickers added (one pool across communities) | 20 | 50 | 250 |
| Bots (not built, see below) | 2 | 4 | 10 |
| Bot directory review (not built) | regular | regular | priority |

Units are decimal: 1 MB = 1,000,000 bytes, 1 GB = 1,000,000,000 bytes. `GET /v2/mojo/catalog` serves this catalog to
every client, so no app hard-codes a limit. A checkout always charges the billing catalog's **published** price
(docs/BILLING.md), never the list price.

**Which plan applies:** the highest of a granting personal subscription (Stripe, or a store later) and any free period
(trial, invite bonus, gift). Signing in grants nothing; nothing a client sends is an input.

## Meldiq Spark

| Level | Active Sparks | Server emoji slots | Largest file for everyone | Voice | Screen sharing for everyone |
|---|---:|---:|---:|---:|---|
| 0 | 0 | 50 (as before) | each person's plan | 48 kbps (as before) | each person's plan |
| 1 | 1 | 100 | 50 MB | 128 kbps | 720p 30 fps |
| 2 | 2 | 200 | 200 MB | 256 kbps | 1080p 60 fps |
| 3 | 3 or more | 500 | 2 GB | 384 kbps | 1080p 60 fps, 2K 30 fps |

- A person's Sparks = their plan's included Sparks + the **Spark add-on's quantity** ($0.99 per Spark per month, a
  recurring Stripe subscription bought with `POST /v2/mojo/sparks/checkout {quantity}`, on any plan including Free).
- **The $0.99/Spark/month cadence is the owner's stated assumption: confirm it before live payments.**
- Give one to any community you're in (`POST /v2/mojo/sparks {orgId}`); move it (`…/:id/move`) or take it back
  (`DELETE …/:id`). No server permission is needed to give one. No cooldown.
- Assignments count **oldest first up to the person's Sparks**. When a plan or the add-on ends, the newest assignments
  are paused (kept, shown as paused, counting again when there's room): nothing is deleted. Only current members'
  Sparks count, so leaving a community stops its Sparks counting there.
- The level is worked out on every request from the assignments: there is no job, and a change applies at once.
  Members are told with the `entitlements.changed` frame (`scope: "org"`).
- A server never shows a level above 3. Extra Sparks can go to other servers.
- **Shared benefits never lower a person's own:** uploads take the higher of the person's plan and the level; screen
  presets are the union of both.
- Emoji slots are the server's capacity, separate from each person's custom-item pool.
- History: every assignment, move and removal is a row (`spark_assignments`), and audited (`mojo.spark_*`).

## Gifts

- Mojo Go or Plus for a friend for 1, 3 or 12 months: a **one-time** Stripe Checkout payment (`mode: payment`) priced
  by the server (the plan's published monthly price × months). Nothing renews.
- The gift exists for the friend only once Stripe's signed `checkout.session.completed` (or `async_payment_succeeded`)
  says it's paid. Duplicate and out-of-order deliveries are idempotent.
- The friend **starts it when they choose** (`POST /v2/mojo/gifts/:id/redeem`). Its time follows on after any free
  period (trial, invite bonus, earlier gift) of the same or a higher plan. A paid subscription doesn't push it back
  (subscriptions renew), so apps warn before starting a gift that overlaps one. Unstarted gifts don't expire.
- Not to oneself. The recipient must be a local, enabled Meldiq person who hasn't blocked (or been blocked by) the
  buyer. Unknown and refused recipients get the same answer, so nobody learns who has an account.
- Refunded before it's started: it can't be started. Refunded after: recorded, access kept (a business decision, as with
  subscriptions).
- The gift note (up to 280 characters) is stored on the server as written: it isn't end-to-end encrypted.

## How each limit is enforced

| Limit | Where | Notes |
|---|---|---|
| Message characters | Apps count grapheme clusters and stop at the plan's limit. The server (`POST /v1/messages`, edits included) refuses ciphertext larger than `24 KiB + 12 bytes × characters` (base64) → `413 message_too_long` | **Messages are end-to-end encrypted: the server can't count characters.** It bounds the encrypted size, so a modified client can't send megabytes, but it can't tell 1,001 characters from 1,000. Counting exactly stays in the apps. Encryption is unchanged |
| File size | Both upload paths, before any byte is read (declared length, then while streaming; direct S3 uploads are bound to their declared size) → `413 upload_limit {maxBytes}` | Never above the server's `FILE_MAX_BYTES`. **Production has 1 GiB today: Plus's 2 GB needs `FILE_MAX_BYTES=2000000000`** (S3 multipart handles it) |
| Screen sharing | Call join and start answers carry `media.limits.screen`; the apps offer only those. LiveKit's `track_published` webhook reports the share's resolution, and a share above the person's presets is **muted** by the server | Frame rates aren't in LiveKit's reports: the apps keep them |
| Voice bitrate | `media.limits.voiceKbps` from the server's level | **Applied by the apps' encoders.** The server can't force a bitrate; it's a ceiling, not a measured rate |
| Custom emoji and stickers | `POST /v1/orgs/:id/expressions`: the server's slots (its level) and the adder's pool across communities → `409 limit_reached` / `custom_items_limit` | Over a limit (a lower level, a lapsed plan) the newest items are **locked**: `locked: "slots" \| "plan"`, kept, still shown in sent messages, not offered for new ones. Upgrading unlocks them. Ties break by id |
| Badges | Member lists and profiles carry `mojo: {badge, check}` from verified billing; `PUT /v2/mojo/badge {hidden}` | Meldiq Check is a Plus perk, **not identity verification**; badges grant no permission |
| Sparks | Every assignment is checked in its own write unit: two taps at once can't give one Spark twice | |

## Not built, and why

- **Bots.** Meldiq has no bot creation and no bot directory: AI agents were removed in API 0.47.0. The catalog keeps
  the agreed numbers (2 / 4 / 10, priority review for Plus) for when bots exist; no client lists them as a benefit.
- **Keeping files forever.** Files are still kept 7 days by the relay, or 365 days when a member's history keeps them
  (`ATTACHMENT_KEEP_DAYS`). The owner wants them kept indefinitely. That's a storage-cost decision (S3) and isn't
  changed here: set `ATTACHMENT_KEEP_DAYS` higher (or teach it "forever") once decided. Downgrades never delete files.
- **Changing the number of Sparks bought.** Buy by quantity at checkout. To change it, cancel the add-on in the portal
  and buy again (the portal's quantity updates would also apply to plans, so they're off).
- **Live payments.** Production runs `BILLING_PROVIDER=none`. Everything above is tested against a recording fake of
  Stripe with webhooks signed as Stripe signs them, not against a Stripe account.

## Going live (owner)

1. Stripe test mode: `admin.js stripe-setup` creates the products **Meldiq Mojo** (Go $0.99, Plus $3.99) and **Meldiq
   Spark** ($0.99 a month), the webhook and the portal (docs/BILLING.md › Stripe Dashboard setup).
2. API `.env`: `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_RETURN_URL`,
   `BILLING_WEB_RETURN_URL=https://web.meldiq.app/settings/mojo`, `FILE_MAX_BYTES=2000000000`.
3. `admin.js billing-mojo-plans <goPriceId> <plusPriceId> <sparkPriceId>` publishes the three plans.
4. Test end to end with Stripe's test cards (subscribe, Sparks, a gift, cancel, refund) before any live key.

## Capacity (measured facts vs estimates)

- Measured: production has 1 GiB `FILE_MAX_BYTES`, 7-day relay retention, a 2 vCPU / 8 GB VPS, LiveKit on the same
  VPS, and MongoDB Atlas M0 (512 MB) for seven domains.
- Estimates:
  - **1080p60 screen shares** need roughly 4× the bandwidth of 720p30 (≈ 6 Mbps vs 1.5–2.5 Mbps per viewer stream).
    On one VPS LiveKit's egress is the first limit. Watch it before many Level 2/3 servers stream at once.
  - **2 GB uploads** go straight to S3 (multipart), so the VPS isn't in the data path. Storage cost grows with
    retention.
  - Billing rows are small (well under 1 MB for thousands of subscribers): Atlas M0 is fine for them.
