# The floating redesign on Android (2026-10-28)

Meldiq Web's "floating" redesign (web branch `floating-redesign`, `docs/MELDIQ_DESIGN_SYSTEM.md` › "The floating
redesign") on the Android app, with the owner's follow-ups of 2026-10-28: no duplicated controls, Settings as a window,
an invitation to Meldiq and a Mojo card in Messages, Meldiq Spark as its own settings page and as a goal in every
community, the new Spark thresholds, and the call screen after the owner's call reference.

## Design system

| Token | Meldiq dark (default) | Meldiq light |
|---|---|---|
| background (the frame) | `#040404` | `#ECECEC` |
| surface (panels, cards, bars) | `#141414` | `#FFFFFF` |
| surfaceVariant (raised rows, inputs, chips) | `#1D1D1D` | `#F2F2F0` |
| border / outline | `#242424` / `#6B6B66` | `#E4E4E0` / `#7A7B74` |
| text 1 / 2 / 3 | `#F6F6F3` `#BDBDB7` `#8F8F89` | `#0B0B0B` `#3F403B` `#63645D` |
| action (primary buttons) / on action | lime `#F4FFAC` / `#0B0B0B` | lime `#D4EE4E` / `#0B0B0B` |
| primary (links, focus, accent text) / soft | `#ECF99C` / `#262918` | `#4D5C00` / `#F2F9D2` |
| accent start → end / on accent | `#F4FFAC` → `#B8E85A` / `#0B0B0B` | `#4D5C00` → `#3F6A08` / white |
| badge (unread) / on badge | `#F4FFAC` / `#0B0B0B` | `#0B0B0B` / `#F4FFAC` |
| mention / on mention | pink `#FF5C93` / `#0B0B0B` | `#D61F62` / white |
| your bubble / text / time | `#222419` `#F6F6F3` `#BDBDB7` | `#F2F6DC` `#0B0B0B` `#3F403B` |
| nav indicator | `#2A2A2A` | `#EEF5CF` |
| call stage | `#050505` | (calls are always dark) |

- The navy palette that was the default from 2026-10-26 stays selectable as **Midnight** (Appearance › Colour). Installs
  on "Meldiq" get the new look, as browsers did on the web.
- Light mode uses `#ECECEC` (the web's `--bg`) rather than the rail's `#E6E6E3`, so green success text keeps 4.5:1 on it.
  Where Android draws lime as text on the light frame it uses the web's `--accent-text` (`#4D5C00`) and a deeper end
  (`#3F6A08`) than `--accent-2`.
- Every pair is checked in `MeldiqPalettesTest` (text 4.5:1, primary text 7:1 on the page, badges and mentions 4.5:1 for
  their digits and 3:1 against their row, outlines 3:1).
- Radii (`Tokens.kt`): cards 18 dp, panels, sheets and dialogs 24 dp, tiles 14 dp, pill buttons. Secondary buttons are
  raised neutral pills with primary text; the primary action is solid lime with near-black text.
- The bottom bar floats: a rounded charcoal bar with the frame's gap around it. The community channel list is a rounded
  panel on the frame.

## No duplicated controls

- **The user panel** (`ui/screens/you/UserPanel.kt`, top of the You tab): you on your banner with your status, your
  microphone, your headphones and Settings. It is the one place for your profile and settings. Tapping you opens
  Status (status, pause notifications, how you appear, My Profile).
- The microphone and headphones: in a call they mute and deafen that call; outside one they say how the next call
  starts (`Settings.joinMuted`, `joinDeafened`; `CallManager` joins muted or deafened accordingly). Rules in
  `UserPanelRules` (unit-tested).
- Removed duplicates: the You tab's "Threads" card (the Activity tab is that), the You tab's User settings, App
  settings and Accounts lists (now in the Settings window), and the old Settings page's profile card.
- Search stays in the community and Messages headers.

## Settings as a window

`ui/screens/profile/SettingsWindow.kt`: Settings opens over the current screen (full height on phones, 10 dp from the
edges, 24 dp corners) with a close button; Back or a tap outside closes it. Its groups follow the web: User settings
(My Account, My Profile, Profile style, Privacy, Devices, Meldiq Mojo, Meldiq Spark, Contacts, Accounts), App settings
(Appearance, Voice & Audio, Notifications, Language, Storage) and Advanced (server health for platform admins, your
federation address, About, Introduction, developer options). A page opened from it is pushed as before; Back from it
shows the window again over the screen it was opened on. Older links to `Routes.PROFILE` / `Routes.SETTINGS` open
the window.

## Messages

- **Invite friends to Meldiq** (`ui/screens/chats/DmPromoCards.kt`): the share sheet with a link to
  `https://web.meldiq.app` and your username (`@name`) to add you by. Community invitations stay in each community
  (its menu › Invite); the app has no profile link of its own yet.
- **Meldiq Mojo card**: your plan, or what Mojo adds; opens the plans.

## Meldiq Spark

- **Settings › Meldiq Spark** (`Routes.SPARK`, `ui/screens/mojo/SparkScreen.kt`): your Sparks, your communities' Spark
  goals (level chip and bar; tap for that community's Sparks: give, take back), the levels and what each gives
  everyone, your Sparks with give, move and take back, and more Sparks (Google Play packs). The Mojo plans page links to
  it instead of carrying it.
- **In each community**: a Spark goal card at the top of the channel list (level, active Sparks, how many more for the
  next level, a progress bar) that opens the community's Sparks, and a level chip by the community's name (Level 1 and
  up).
- **Thresholds** (owner's decision 2026-10-28: Level 1 at 2 active Sparks, Level 2 at 5, Level 3 at 8, totals) come from
  the server's catalog (`GET /v2/mojo/catalog` › `spark.levels[].sparks`) and the community's own answer
  (`GET /v1/orgs/:orgId/sparks` › `level`, `next`). `SparkGoalRules` assumes no number; `SparkGoalRulesTest` checks 2/5/8
  and the older 1/2/3.

## Calls

After the owner's call reference: the call stage is near-black; one rounded charcoal control bar of round buttons
(microphone, camera, the red hang-up in the middle, share, audio output), with labels for TalkBack; tiles are rounded
with a lime ring on whoever speaks, the name at the bottom left and a round muted or speaking badge at the bottom
right; a shared screen sits on a rounded stage above a filmstrip of wider tiles. In a voice channel's list, people
sharing their screen in the call you're in carry a lime **Live** chip.

## Screenshots

Rendered from the app's own components and theme on the JVM (Robolectric native graphics), in
[`docs/screenshots/android-floating-2026-10-29`](screenshots/android-floating-2026-10-29): the community with its Spark goal
and level chip, Messages with the notice, the Meldiq invitation and the Mojo card, the user panel over the Settings window,
a community call, the Spark goals, light mode and the Midnight palette. Make them again with
`./gradlew :app:testDebugUnitTest -Pmeldiq.screenshots=true --tests '*DesignScreenshotsTest*'` (they land in
`android/app/build/screenshots`; skipped in ordinary test runs). The data in them is made up.

## Not done here

- The owner's 2026-10-28 decision to drop end-to-end encryption and keep messages on the server only: waits for the API
  contract from the web/API session.
- Game activity ("Playing PUBG"): its own session (API field and opt-in usage-access detection).
- The call reference's chat and full-screen buttons: the call screen is already full screen on phones, and the chat
  stays one Back away (minimise).
