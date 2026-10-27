# Meldiq Android ↔ Meldiq Web parity (2026-10-28)

The owner asked: "check the codebase, match the web app's features and design, then do it". Reference: meldiq-web at
`a9eb914` (production web `564e3b0`, API 0.47.0). Android had last matched the web at API 0.41.0 (AI Workforce,
`e454b7a`). Every web release since then (community-first 0.42.0, Meldling 0.43.0, branding 0.44.0, continuation v3
0.45.0, stage 1 0.46.0, AI removal 0.47.0) said "Android: not yet". This round brings those to the app.

Branch `android-web-parity` (5 commits on `internal-beta` e80986e). No server change: everything uses routes and fields
API 0.47.0 already serves.

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
| Lint, APK | see the session record below |
| Emulator | see the session record below |

Not tested: a physical phone, production accounts (no production test account), two-step sign-in against the live
server, uploads of animated avatars and banners against the live server.
