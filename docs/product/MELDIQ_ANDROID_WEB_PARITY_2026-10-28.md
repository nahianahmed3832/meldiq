# Meldiq Android ↔ Meldiq Web parity (2026-10-28)

The owner asked: "check the codebase, match the web app's features and design, then do it". Reference: meldiq-web at
`a9eb914` (production web `564e3b0`, API 0.47.0). Android had last matched the web at API 0.41.0 (AI Workforce,
`e454b7a`). Every web release since then (community-first 0.42.0, Meldling 0.43.0, branding 0.44.0, continuation v3
0.45.0, stage 1 0.46.0, AI removal 0.47.0) said "Android: not yet". This round brings those to the app.

Branch `android-web-parity` (6 commits, rebased on `internal-beta` 1183ae9, API 0.49.0). No server change: everything
uses routes and fields API 0.47.0 already serves.

## Done

| Web release | Android now | Commit |
|---|---|---|
| 0.47.0 AI removed | AI agents, AI Workforce, AI readers and the `ai.*` frames are gone (the routes answer 404 now; the codec test failed on the frames the server no longer sends) | part 1 |
| 0.46.0 two-step sign-in | Password sign-in asks for the authenticator or backup code (`totp_required`), so accounts with two-step on can sign in on Android again. You › Account safety turns it on (key, Open authenticator app, first code, ten backup codes shown once) and off | part 1, account safety |
| 0.43.0 channel read sync | Reading a channel or large group sends "read up to here" to your own other devices only (`audience: "self"`); a read from elsewhere clears here unless something newer arrived | part 1 |
| v3 invite links | Links are made on `web.meldiq.app` (meldiq.app serves no pages); old meldiq.app/www links and `web.griipbuddy.cloud` still recognised; App Links for web.meldiq.app | part 1 |
| 0.42.0 Meldiq palette | The default palette (deep navy, cyan/blue/violet, pink mentions); installs on Graphite move to it, other choices are kept. Two tones are a shade off the web's so text reaches 4.5:1 (tested) | part 1 |
| 0.43.0 Meldling | Launcher, themed and notification icons, launch screen and in-app tile rendered from `brand/meldling.png` (`android/scripts/render_brand.py`); the Messages tab and the typing indicator use a tinted Meldling | part 1, part 2 |
| 0.42.0 unread rule | One rule (web `ui/unread.ts`): a dot for one channel message, a light count for more, a DM's count in the accent, the pink "@N" for mentions, on channel rows, DM rows and the rail | part 2 |
| 0.42.0 who reacted | Long-press a reaction: everyone who reacted, one tab per reaction | part 2 |
| 0.42.0 live-call badges | Rows show voice / video / screen sharing and how many are in the call (`sharing` on call frames) | part 2 |
| 0.43.0 typing | "Meldling…" with a fading ellipsis; screen readers hear the names | part 2 |
| 0.45.0–0.46.0 profile look | Animated avatars (GIF/WebP play on Android 9+, a clip shows its still), frames, banners with effects and colour, name fonts (the web's OFL fonts), colours/gradients with glow or shimmer, worn community tags, About me, links, Bug Hunter badge; in messages, member lists and profiles (`users.lookJson`, DB v14). You › Profile style edits all of it | part 3 |
| 0.44.0 / 0.46.0 community branding | Accent on the rail ring, banner or accent band above the channels and in the Discover preview; Community settings › Appearance for accent, banner and tag (web `accent.ts` readability rules, tested) | part 3, part 4 |
| 0.42.0 / v3 Invite people | One sheet: add people you know (up to 20, each outcome shown) or a link with an expiry (1 h–30 days) and a use limit (1–500), Copy link, Copy code, Share; Manage invitations | part 4 |
| 0.46.0 community mute | Mute a whole community for 15 min to "until I turn it back on", synced (`community.mutedUntil`); every channel counts as none while it runs | part 4 |
| 0.46.0 account safety | Change email with a code to the new address, account standing with its warnings, bug reports with their status | account safety |

## Not done (and why)

- **GIF search** (0.45.0): off in production until a provider key is set (`GIF_PROVIDER`, `GIF_API_KEY`); the
  Android picker can follow once it's on.
- **Import from Discord** (0.43.0): off in production until a Discord application exists.
- **Colour themes / gradients for the whole app, keyboard shortcuts, Builder mode, the desktop user panel**: web-only
  (desktop) or not yet asked for on phones. Android keeps its palettes and Settings › Appearance.
- **Download your data, log out everywhere**: Android already lists and signs out devices (Settings › Devices); a
  "log out everywhere" button can follow.
- **Voice & Audio**: Android already has noise reduction, deafen and the pre-call check (B10); push-to-talk is a desktop
  feature.
- **Resumable transfers (v3)**: Android has its own retry (`TransferRetry`); the web's change made it match Android.

## Checks

| Check | Result |
|---|---|
| Unit tests (`:app:testDebugUnitTest`) | baseline 708 with 1 failure (AI frames); now **730 passed, 0 failed** (new: two-step, read rules, unread rule, accent, person look, community mute, account safety) |
| Lint (`:app:lintDebug`) | 0 errors (801 warnings, as before) |
| APK | `android/app/build/outputs/apk/debug/meldiq-test-web-parity-production-debug.apk` (side by side as "Meldiq Test", production server), sha256 `53c2b701…3a0db4b6` |
| Emulator (Medium_Phone_API_36.1) | installed over the existing test app with its data kept: the database moved to v14, the palette moved to Meldiq ("Dark · Meldiq"), the Meldling Messages tab and the pink count show, You and Settings list Profile style and Account safety, Profile style opens. Signed-in screens couldn't be exercised: the emulator's test account belongs to a local server that's gone, and signing up another account there means erasing the phone's data first |

## Second pass (2026-10-28, against Meldiq Web v4 `fbe8ba3` and stage 1's Appearance)

The owner asked to check everything again, add the newer customisation and use a more modern design.

| Web | Android now | Commit |
|---|---|---|
| v4: safety numbers retired | No safety number cards, Mark as verified or verified points; a changed key still pauses messages, and the profile asks to confirm it in person or on a trusted call | `5331f58` |
| v4: old account flows retired | "Move an account from before email" is no longer offered at sign-in; a phone that holds such an account is still taken through the move | `5331f58` |
| v4 / API 0.48.0: stable channel order | Categories keep their saved order before the category list loads (`categoryPosition`, DB v15) | `5331f58` |
| v4: connection banner | Shows only after 1.5 s down | `5331f58` |
| Stage 1: Colour themes | Settings › Appearance › Colour themes: none, the web's twenty gradients or a custom theme of two or three colours, with strength; one soft layer over the app | `316913f` |
| Stage 1: Use a community's own colours | A switch under Colour themes; off keeps Meldiq's colours on the rail and hides community banners | `316913f` |
| v4: phone You tab | Your card (banner, animated avatar, styled name, @username, Status for status, pause and presence), shortcuts, then User settings and App settings as plain grouped lists | `316913f` |
| Modern lists | Every settings row uses a plain monochrome glyph instead of a coloured tile (only destructive and warning rows keep a colour) | `316913f` |

Still web-only: message bubbles on the rail (Android's rail has no Home button; DMs are their own tab), keyboard
shortcuts, Builder mode and "Install as an app" (desktop browser features), and the rail folders coming in API 0.50.0.

## Follow-ups

- API 0.48.0 added `categoryPosition` on channels (web v4: a stable channel order); Android still orders by its own
  rule and ignores the field.
- Pushing these commits and a release build wait for the owner (versionCode and versionName in the main folder's
  uncommitted `build.gradle.kts` are the owner's).

Not tested: a physical phone, production accounts (no production test account), two-step sign-in against the live
server, uploads of animated avatars and banners against the live server.
