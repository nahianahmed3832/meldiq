# Meldiq Mojo on Android: Google Play Billing (2026-10-28)

Meldiq Mojo (Mojo Go, Mojo Plus), Meldiq Spark and gifts on the Android app. The server is the only source of truth for
what an account has (`GET /v2/billing/entitlements`, docs/BILLING.md); Android shows it and sells through Google Play.
The plan limits come from the server's catalog (`GET /v2/mojo/catalog`, server `billing/perks.ts`, docs/MOJO.md); the
app keeps no plan table of its own.

## What is built, and what isn't yet

| Part | State |
|---|---|
| Android: Play Billing Library 9.1.0, product query, purchase sheet, plan change with proration, restore, reconcile on start and resume | built (`data/billing/`) |
| Android: Meldiq Mojo screen (plans with Play's localized prices, current plan and its source, compare table, Spark levels and packs, gifts, why subscriptions), entry in You › User settings | built (`ui/screens/mojo/`) |
| Android: message character counter from the plan (grapheme clusters, edits included; Send waits, nothing is cut) | built |
| Android: your Sparks (give, move, take back, with a warning when a server would drop a level), server menu › Meldiq Spark (level, next level, give), badge show or hide, gifts received (start, with a warning when it overlaps a paid plan) and sent | built against API 0.54.0's `/v2/mojo/me`, `/v2/mojo/sparks*`, `/v2/mojo/badge`, `/v2/mojo/gifts/:id/redeem`, `/v1/orgs/:orgId/sparks` (the web session's shapes) |
| Android: attachment pre-check by plan and server level | not changed: the server enforces (413 `upload_limit` with `details.maxBytes`: the higher of the person's plan and the server's Spark level, capped by the server's `FILE_MAX_BYTES`, 1 GiB in production). Plus's 2 GB needs `FILE_MAX_BYTES` raised on the server **and** the app's own 1 GiB cap (`AttachmentPolicy.APP_MAX_FILE_BYTES`) raised after a 2 GB upload is tested on a device |
| Server: plan catalog, limits, Spark levels, gifts (Stripe on the website) | API 0.54.0, the web session (`subscriptions-api` branch) |
| Server: Google Play (`/v2/mojo/play/intent`, `/v2/mojo/play/verify`, `/v1/billing/webhooks/google_play`, reconciliation) | API 0.55.0: `billing/play.ts`, `billing/providers/googlePlay.ts`, migration `065_play_purchases.sql`, tests `server/test/play.test.ts` |

Nothing can be bought until the owner's Play Console products exist and the server has `GOOGLE_PLAY_*` set (below).
Until then the Mojo screen shows the plans and what they include, and says purchases aren't open.

## Gifts (the server's rules, API 0.54.0)

The recipient starts a gift whenever they like; it never renews. If they already have free Mojo time (a trial, an invite
bonus or an earlier gift) of the same or a higher plan, the gift follows on after it. A paid subscription doesn't push it
back (it renews), so the app warns before starting a gift while paying for the same or a higher plan. Unstarted gifts
don't expire. A gift refunded before it is started can't be started. Gifts to oneself are refused.

## How a purchase works

1. The app queries Google Play for the products below (`queryProductDetailsAsync`). A product Google doesn't return isn't
   offered: its card says "Not on sale in Google Play yet". Prices on buttons are Google's localized ones.
2. On Buy, the app asks the server for an intent (`POST /v2/mojo/play/intent {kind, productId, replacing?, giftTo?,
   note?}`). The server records what is being bought (a checkout row for a plan or Spark pack, a pending gift) and
   answers `{reference, accountToken}`. It refuses a plan or pack when the website already bills one (`billed_elsewhere`),
   and a second Play subscription unless the intent names the one it replaces.
3. The app opens Google Play's sheet with `obfuscatedAccountId = accountToken` (an opaque value the server derives
   from the account, never an email, phone number or id) and `obfuscatedProfileId = reference`.
4. Google's result comes back to the app. Pending payments grant nothing. A completed purchase's token goes to the server
   (`POST /v2/mojo/play/verify {productId, purchaseToken}`).
5. The server reads it from the Google Play Developer API, checks that it is one of our products, that Google's
   `obfuscatedExternalAccountId` is this account's token and that its profile id is one of this account's own intents;
   records it once (one Google purchase, one Meldiq account); applies Google's state through the same subscription core
   and gift rules as Stripe's events; acknowledges (subscriptions) or consumes (gifts) it with Google only once the grant
   is stored; and answers `{status}`.
6. The app shows "It's on your account" only on `granted`. `pending`, `already_linked` (another Meldiq account owns this
   Google purchase) and `invalid` are shown as they are.
7. Anything missed (the app killed during the sheet, no network) is sent again at app start and on resume: Google keeps
   a purchase unacknowledged until the server confirms it, and the server's verification is idempotent. A purchase never
   acknowledged within 3 days is refunded by Google, which is the right outcome for one the server couldn't verify.

Plan changes use `SubscriptionProductReplacementParams` with `WITH_TIME_PRORATION` (applies at once; Google credits the
unused time). Cancelling opens Google Play's own subscriptions page (the documented deep link with `sku` and `package`).
A plan billed on the website (Stripe) is shown with its source and is never offered again on Android; Android never
links to the website's checkout.

Google's states: active and **in grace period** keep the plan (Google keeps access while it retries a payment; Google
Play itself tells the person to fix it); cancelled keeps it until the paid time ends; **on hold** and paused remove it;
expired ends it; pending grants nothing. A plan change's new purchase names the one it replaces
(`linkedPurchaseToken`): the old one ends at once even if Google hasn't reported it yet. A voided gift (refund,
chargeback) can't be started any more.

Google's real-time notifications (Pub/Sub push to `/v1/billing/webhooks/google_play`) are checked as Google signs them
(an OIDC token for that URL, from the push subscription's service account); the server then reads the purchase from
Google and applies that, never the message. A purchase the app never sent (killed during the sheet) is applied from its
notification. The cleanup job re-reads unacknowledged purchases after five minutes and the rest every six hours.

**The plans must be published in the billing catalog** (as `admin.js stripe-setup` does for `go`, `plus` and `spark`):
Google Play sells them under its own product ids and a Play subscription is on the plan's current published terms.

## Play Console products (owner creates them)

App: `com.meldiq.android` (unchanged). All ids are lowercase; base plans are monthly, auto-renewing.

| Product id | Type | Base plan | Target price (USD) | Grants |
|---|---|---|---|---|
| `mojo_go` | subscription | `monthly` | 0.99 / month | Mojo Go |
| `mojo_plus` | subscription | `monthly` | 3.99 / month | Mojo Plus |
| `spark_1` | subscription | `monthly` | 0.99 / month | 1 extra Spark |
| `spark_2` | subscription | `monthly` | 1.98 / month | 2 extra Sparks |
| `spark_3` | subscription | `monthly` | 2.97 / month | 3 extra Sparks |
| `spark_5` | subscription | `monthly` | 4.95 / month | 5 extra Sparks |
| `gift_go_1m` | one-time (consumable) | | **owner to set** (proposed 0.99) | Mojo Go for 1 month, for a friend |
| `gift_go_3m` | one-time | | **owner to set** (proposed 2.97) | 3 months |
| `gift_go_12m` | one-time | | **owner to set** (proposed 11.88) | 12 months |
| `gift_plus_1m` | one-time | | **owner to set** (proposed 3.99) | Mojo Plus for 1 month |
| `gift_plus_3m` | one-time | | **owner to set** (proposed 11.97) | 3 months |
| `gift_plus_12m` | one-time | | **owner to set** (proposed 47.88) | 12 months |

- **Spark price is an assumption to confirm before launch:** $0.99 per extra Spark per month, as a recurring add-on.
- **Why packs:** Google Play can't sell one subscription in a chosen quantity (multi-quantity subscriptions were announced
  in September 2026 as early access only). Each pack is its own subscription and a person holds **one pack at a time**
  (the server keeps one Spark add-on per account): choosing another pack is a plan change that replaces the old one,
  with Google's proration. Nobody can stack two packs by accident. Put the four packs in one Play Console subscription
  group so Google treats them as alternatives.
- **Gift prices** are the monthly price × months above, with no discount, until the owner decides otherwise.
- Prices in other countries: set them in Play Console (Google converts from USD by default; check the result).

## Owner checklist (Play Console and Google Cloud)

These can't be done from code. Do them in this order, test mode first.

1. **App identity:** Play Console › the Meldiq app: package `com.meldiq.android`, the existing signing. Nothing changes.
2. **Payments profile and merchant account:** Play Console › Settings › Payments profile. The organization's legal name,
   address and tax details must match the verified organization. Accept the merchant terms Google asks for.
3. **Payouts:** add the organization's bank account in the payments profile for the right country. Google pays sales
   to it on its own schedule, minus its service fee; check the current terms in Play Console for the numbers.
4. **Products:** Play Console › Monetize › Products: create the subscriptions and base plans above (Subscriptions), then
   the six gift products (One-time products). Activate each.
5. **Developer API access:** Google Cloud project linked to Play Console (Play Console › Setup › API access); a service
   account with only **View financial data** and **Manage orders and subscriptions** for this app. Its JSON key goes on
   the API server only (below), never in the app, a resource, `BuildConfig` or Git.
6. **Real-time developer notifications:** Google Cloud Pub/Sub topic (e.g. `meldiq-play-rtdn`), grant
   `google-play-developer-notifications@system.gserviceaccount.com` the Publisher role on it, a push subscription to
   `https://msg.meldiq.app/v1/billing/webhooks/google_play` with authentication (a service account whose OIDC token the server
   verifies; audience = that URL). Play Console › Monetize › Monetization setup: the topic name; send a test
   notification. Use a separate topic and subscription for testing.
7. **Testing:** add license testers (Play Console › Settings › License testing); upload a signed build to the
   **internal testing** track; install it from the Play Store testing link (a sideloaded or debug build can't buy).
   Test with the test cards Google offers license testers: buy, renew (test subscriptions renew every few minutes),
   cancel, a pending payment ("slow test card"), a declined one, refunds and revocations from Play Console › Order
   management, a plan change, a gift, restoring on a second phone. Never test with a real charge.
8. **Policy:** check the current Payments policy and the app content declarations (Data safety: purchase history),
   and that the in-app subscription terms are clear (they are on the Mojo screen and in Google's sheet).

Customers pay in Google Play's own checkout with the methods Google offers in their country; Meldiq never sees card
details.

## Server environment (Play adapter; names only)

| Variable | |
|---|---|
| `GOOGLE_PLAY_PACKAGE` | `com.meldiq.android` |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE` | path to the service account's JSON key on the server (mode 600) |
| `GOOGLE_PLAY_RTDN_AUDIENCE` | the push endpoint URL the Pub/Sub OIDC token must name |
| `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT` | the push subscription's service account email (the token's `email` claim) |
| `GOOGLE_PLAY_ACCOUNT_TOKEN_SECRET` | HMAC key for `obfuscatedAccountId` (32+ characters, `openssl rand -hex 32`). Never change it once purchases exist: their account tokens would no longer match |

`bash deploy/scripts/validate-env.sh` checks them. Without the two `RTDN` settings, purchases still verify from the app
and are reconciled by the cleanup job, but changes (renewals, cancellations, refunds) arrive hours late.

Purchase tokens are stored (`billing_play_purchases.purchase_token`, to ask Google again) and never logged, returned to a
client or used as a reference: subscriptions and events carry the token's SHA-256.

## Tests

- `MojoPlansTest`: plan card actions (buy, upgrade with replacement, cancel in Play, managed on the website,
  unavailable), grapheme counting (emoji with skin tones, flags, Bengali, Chinese), the composer counter, personal and
  server limits (a server never lowers a plan), levels capped at 3, product ids, the manage link.
- `MojoRepositoryTest`: nothing is granted before the server confirms; pending payments aren't verified; refusals
  (`already_linked`, `invalid`), cancellation and Play errors; a purchase the server couldn't confirm is sent again by
  reconciliation; one purchase at a time.
- `ApiRoutesTest` and `RealtimeCodecTest`: every route the app calls and every frame the server sends are in the
  server's generated contracts (`docs/api`).
- Server `test/play.test.ts` (Google's API is a fake; notifications signed with a test key as Google signs them): a
  purchase grants only once Google says it's paid and is acknowledged after; the same token twice; another account's
  token (`already_linked`); a purchase not made through the account's own intent; plan and pack changes; grace period,
  on hold, cancellation and expiry; pending payments; a purchase applied from its notification alone; the website's
  plan isn't sold again; gifts delivered, pending, mismatched and refunded; forged, expired, wrong-audience and unsigned
  notifications; Google unreachable (Pub/Sub retries); acknowledgement retried by reconciliation.
- Needs Play Console products and an internal-testing build: everything in the owner checklist's step 7.
