# Meldiq — Design System

> **2026-10-28, the floating redesign (current).** As Meldiq Web: a near-black frame, charcoal panels floating on it, one
> restrained lime for primary actions, selection and unread, pink only for mentions; 18 dp cards, 24 dp panels and sheets,
> pill buttons; the user panel, Settings as a window, Meldiq Spark goals and the restyled call screen. The navy default of
> 2026-10-26 stays as **Midnight**. Tokens, rules and screens: [FLOATING_REDESIGN_ANDROID.md](FLOATING_REDESIGN_ANDROID.md).

> **2026-10-19 round 6: Graphite was the default (superseded).** The owner found the pastel look uncomfortable for long
> working days and asked for a professional dark theme by default, inspired by the way dark collaboration apps layer
> charcoal surfaces (Meldiq's own design: nothing copied). New installs start in **dark mode with Graphite**; existing
> installs move once (`designVersion` 2: "follow the system" becomes dark, an explicit Light or Dark choice is kept, the
> preset becomes Graphite). Aurora, Sunset and Meadow remain as choices. The header is flat (no gradient), and there is
> one restrained accent, the logo ribbon's indigo.
>
> | Token | Graphite dark (default) | Graphite light |
> |---|---|---|
> | background (canvas) | `#1E1F24` | `#F4F5F7` |
> | surface (bars, cards, header, composer row) | `#26282E` | `#FFFFFF` |
> | surfaceVariant (inputs, chips, pressed rows) | `#2F3138` | `#EBECEF` |
> | border / outline | `#383B43` / `#7A7F8C` | `#DCDEE3` / `#7A7F8C` |
> | text 1 / 2 / 3 | `#ECEDF0` `#B6BAC3` `#989DA8` | `#17181C` `#4A4D57` `#5D616C` |
> | primary (links, focus) / soft | `#A5ADFF` / `#2E3150` | `#4B4FC9` / `#E8E9FB` |
> | action / on action | `#5A5FD8` / white | `#4B4FC9` / white |
> | accent (single colour) / on accent | `#8B93FF` / `#14163A` | `#4B4FC9` / white |
> | header / search field on it | `#26282E` / `#1E1F24` (inset) | `#FFFFFF` / `#EBECEF` |
> | badge / on badge | `#F06A6F` / `#2A0A0C` | `#C42B32` / white |
> | your bubble / text / time | `#33365A` `#EEEFFD` `#BCC0E6` | `#E6E7FA` `#17181C` `#4A4D70` |
> | nav indicator | `#383B52` | `#E3E4F7` |
>
> Every pair is in `MeldiqPalettesTest` (primary text ≥ 7:1 on the page; all text ≥ 4.5:1 on page, cards, inputs and
> header; badges ≥ 4.5:1 for their digits and ≥ 3:1 against their row; outlines ≥ 3:1), plus a Graphite test for the
> layering (canvas darker than cards darker than inputs, not pure black, flat header, single accent).
>
> **Conversations.** The permanent "End-to-end encrypted" chip is gone. A small padlock in the header (warning colour
> when a member's key changed) opens a Security panel listing only what applies: messages and files end-to-end
> encrypted; calls end-to-end encrypted or only in transit (the call setting); verified or not; members on other
> servers; channel app updates not end-to-end encrypted; what the server can see (`data/model/ConversationSecurity.kt`).
> The composer grows line by line up to six lines (then scrolls inside), with an animated height (still when animations
> are off), tighter corners once it wraps, and a 1 dp border so it reads against the composer bar.
>
> **First run.** Five short introduction pages before Welcome (talk, reminders, voice, apps, People & HR marked
> "Coming soon"), with Skip, page dots that don't rely on colour, and no permission requests; shown once and replayable
> from Settings › Introduction.

> **2026-10-19, the Meldiq design system (current).** Built from the owner's two references: the three-theme workspace
> mock-up (lavender/blue/pink, peach/magenta, mint/green) and the official logo (`brand/meldiq-logo.webp`: a cyan → blue →
> violet ribbon "M" with a chat tail on navy). It replaces Ivory/Cocoa below; every screen follows the person's theme
> (System, Light, Dark) and colour preset (Settings › Chats › Appearance). Code: `ui/theme/MeldiqPalettes.kt` (presets),
> `ui/theme/Color.kt` (token names), `ui/theme/Tokens.kt` (space, shapes, motion, `rememberReducedMotion`).
>
> **Presets.** One preset changes the whole palette (header gradient, actions, badges, tinted neutrals), never single
> screens. Contrast for every text/surface pair, badge, button, outline and banner is unit-tested in both modes
> (`MeldiqPalettesTest`: text ≥ 4.5:1, primary text ≥ 7:1 on the page, outlines and badges ≥ 3:1).
>
> | Token | Aurora light (default) | Aurora dark | Sunset light | Sunset dark | Meadow light | Meadow dark |
> |---|---|---|---|---|---|---|
> | background | `#F4F5FB` | `#0A0E27` (logo navy) | `#FBF5F3` | `#170E12` | `#F3F8F4` | `#08130D` |
> | surface | `#FFFFFF` | `#121736` | `#FFFFFF` | `#22151B` | `#FFFFFF` | `#0F1D15` |
> | surfaceVariant | `#ECEEF8` | `#1B2145` | `#F6ECE9` | `#2E1E25` | `#E8F1EA` | `#18291F` |
> | border / outline | `#DDE0EE` / `#7C82A8` | `#272E57` / `#6F77A6` | `#EBDDD8` / `#9A8780` | `#3D2A32` / `#8A7079` | `#D7E4DA` / `#7E9284` | `#22372A` / `#6C8A76` |
> | text 1 / 2 / 3 | `#121433` `#444868` `#5A5E80` | `#ECEEFB` `#B4B9DA` `#959BC2` | `#24131A` `#5B4450` `#6E5662` | `#FBEFF2` `#D3BCC4` `#B49DA6` | `#0F1E15` `#3E5246` `#536759` | `#E9F4EC` `#AFC6B6` `#91AA99` |
> | primary (links, focus) | `#4441D0` | `#A3A5FF` | `#A12460` | `#FF9DC5` | `#0E7340` | `#6EDB9E` |
> | action / on action | `#4441D0` / white | `#5552E0` / white | `#A12460` / white | `#B23A70` / white | `#0E7340` / white | `#17804A` / white |
> | accent start → end | `#4441D0` → `#7B35D9` | `#3CD6EE` → `#B49BFA` | `#B83A1E` → `#A12460` | `#FFAE7A` → `#FF8DB8` | `#0E7340` → `#0B6B5E` | `#6EDB9E` → `#5ED6C8` |
> | header gradient (left → right) | `#F1E4FA` `#E4E5FB` `#D8E7FC` | `#1E1C4E` `#172352` `#112A55` | `#FFE8D6` `#FDE2E0` `#FBDCEA` | `#3A1D20` `#3A1B28` `#3A1830` | `#E3F7E2` `#D7F3DD` `#CBEFD8` | `#10301E` `#0F2D22` `#0E2A26` |
> | header field | white 70% | white 10% | white 70% | white 10% | white 70% | white 10% |
> | badge / on badge | `#D1245A` / white | `#FF7AA2` / `#2B0715` | `#B4281E` / white | `#FF8A7A` / `#2D0905` | `#0E6B3A` / white | `#6EDB9E` / `#052414` |
> | your bubble / text / time | `#E7E6FC` `#15163A` `#4F5180` | `#2A2D6A` `#EEEFFD` `#B9BBE8` | `#FBE3EC` `#2A1018` `#7A4A5C` | `#4A2333` `#FCEFF3` `#E0B9C7` | `#DCF1E2` `#0E1F14` `#3F6B4E` | `#164A2E` `#EAF7EF` `#A9D3B8` |
> | nav indicator | `#E3E2FB` | `#272B63` | `#F8DCE8` | `#4A2333` | `#D5EEDC` | `#1A4029` |
>
> Shared semantic colours: danger `#C42B2B` / `#FF8A80`, warning `#8A5A00` / `#F2C26B`, success `#13784A` / `#6EDAA4`
> (light / dark), with soft banner fills. The call screen is always the preset's dark palette.
>
> **Brand.** The logo is the only source for icons (`android/scripts/render_brand.py`, nothing redrawn): adaptive launcher
> icon (logo on its navy ground `#071231`, mark inside the safe zone), themed monochrome icon and notification icon (the
> ribbon only), the launch screen (logo on navy, shown only until the first frame) and the in-app tile (`MeldiqLogo`).
> The welcome hero is the logo over a soft accent glow, settling in once (still when animations are off).
>
> **Home** follows the reference: header gradient with the workspace mark and name, a translucent search field and
> filter, then the content on a sheet with a rounded top; quick cards (Threads, Later, Drafts & sent, Calls) scroll
> sideways; unread counts are solid badges; the New button is the action colour; the tab bar is a full-width surface
> bar with a soft indicator pill. A **Get started** checklist (profile photo, workspace, a teammate, notifications, apps —
> optional) is checked off from real state and can be hidden.
>
> **Conversations** default to the **Stream** layout: each run of messages starts with the sender's avatar, name and time;
> the rest of the run lines up under it; your own messages sit on the same side (your name in the accent) with their
> delivery state at the row's end. Reactions are bordered chips with counts; threads are a "n replies · View thread"
> chip. Bubbles stay available (Settings › Chats › Message layout). Under the header, chips show the encryption, pinned
> messages, files and what you saved here; search finds messages on this phone and jumps to them.
>
> **Motion** stays short (160–220 ms state changes, 420 ms one-off entrances), never loops while idle, and is still when
> the system's animations are off (`rememberReducedMotion`). Text never fades for decoration.

> **2026-10-18 (UI-001), the first Meldiq direction (superseded 2026-10-19):** two palettes, **Ivory** for sign-in and
> **Cocoa** (dark, peach/pink) for every signed-in screen whatever the theme. Both were removed on 2026-10-19 in favour of
> the presets above and the person's own theme choice.

> **2026-10-16 redesign:** the glass, gradient and teal/lavender/peach language below was replaced by a flat emerald-on-neutral
> system (tokens in `ui/theme/Color.kt`, components in `ui/components`). See `UI_REDESIGN.md` for the current system. The rest
> of this file is the original rationale, kept for history.
>

## 1. Reference analysed

One reference was supplied: a six-screen mobile concept for a dental-care app ("Healthy Smile / Happy Life").
It sets the visual system for the whole of Griip Message. It shows these screens: onboarding hero, greeting dashboard, filterable
catalogue list, booking calendar, tabbed health report, and profile/settings. The reference was inspected
directly (image `1.webp`, 736×1104). Colours were sampled from the pixels with a script, not estimated by eye.

We translate its **visual language**. We do not copy its content: no teeth, no dental copy, no logos, no
3D product renders. Griip Message gets its own mark (a glossy speech bubble with a shield-lock) and its own
illustrations, drawn in code.

### Sampled values (reference → interpretation)

| Sample point | Pixel | Interpretation |
|---|---|---|
| "Get Started" CTA | `#2DBDAF` | Primary teal |
| Featured card, left → right | `#31C3C4` → `#41B9B0` | Cyan-teal gradient for hero surfaces |
| Selected nav item / toggle | `#1AABA1` / `#2FAC9D` | Primary, slightly deeper for small marks |
| "Happy Life" accent text (darkest AA pixel) | `#0C746A` | Deep teal for text-on-light accents |
| Headline text | `#00110D` | Near-black with a green-teal cast |
| Body copy | `#475A56` | Teal-grey secondary text |
| Description text | `#878278` | Warm grey tertiary text |
| Card fill inside phone | `#F5F2EC` / `#FEF9F6` | Warm translucent white |
| Background corners | mint `#BFE6E3`-ish → peach `#FFD5BC` | Diagonal mint → peach canvas |
| Purple icon tile | `#F3EAF9` | Lavender secondary accent |
| Emergency icon | `#E18464` | Coral for danger and urgency |

### Character of the reference

**Soft, premium, airy glassmorphism on a pastel gradient.**
- Pale mint → white → peach diagonal canvas. Content sits on translucent, frosted white cards with
  hairline white borders and very soft teal-tinted shadows.
- A single saturated colour, teal, does all the work for actions and selection. Everything else is neutral.
- Generous radii (cards ≈ 20–24 dp, pills fully round), generous whitespace, low information density,
  strong hierarchy built from weight and colour rather than lines or dividers.
- Primary CTAs are **full-width teal pills with a circular "arrow knob"** at the trailing end.
- Selection uses **filled teal pills** (filter chips, segmented tabs, time slots, calendar day) on neutral
  translucent pills.
- Icons are thin line icons inside **tinted rounded-square tiles** (teal, lavender, coral).
- Lists are **stacked frosted cards**. Each has a leading visual tile, a bold title, a grey description, a trailing
  value, and a circular teal arrow button.
- Screen headers use a centred title, a back arrow on the left and one contextual action on the right.
- The dashboard opens with a greeting ("Good Morning, Alex 👋"), the avatar and a bell, then a search pill,
  then a featured gradient card.
- Data is shown as a ring gauge, a slim progress bar and a three-up stat tile row.
- Bottom navigation has four items. The selected one is teal with a label; the others are grey.

## 2. How the reference maps to Griip Message

| Reference element | Griip Message use |
|---|---|
| Onboarding hero + two-tone headline + pill CTA + page dots | Welcome screen: "Talk freely. / Work together." with a code-drawn glossy bubble-and-shield hero |
| Greeting header + bell + avatar | Home: "Good morning, {name} 👋", connection dot, avatar |
| Search pill with trailing filter icon | Search across conversations, people and channels |
| "Your next appointment" gradient card | Live workspace card: active call (Join) or current branch with unread summary |
| Quick-action icon tiles | New message, Find people, Start call, Announce |
| Ring gauge "Dental Health Score" | "Inbox health": share of conversations read, plus connection and encryption status |
| Treatments list (tile, title, desc, price, arrow) | Teams, channels and branches lists (icon tile, name, topic, member count, arrow) |
| Filter chips (All / General / Cosmetic …) | Conversation filters (All / Direct / Groups / Channels) and the branch switcher |
| Segmented tabs (Overview / History / Analysis) | Workspace tabs (Teams / Channels / People), call participants vs chat |
| Calendar + time slot grid | Member role picker grid, invite expiry/uses picker |
| Doctor card with rating | Member / contact card with role badge and presence |
| Stat tile row (Cavities / Plaque / Gum) | Workspace stats (Members / Teams / Channels), call stats |
| Profile header card + menu rows + teal switch | Profile & settings (Devices, Recovery key, Security, Notifications, Appearance, Server) |
| "View Full Report" CTA | Primary actions at the bottom of detail screens (Create invite, Start call, Join) |

Messaging-specific components that the reference does not contain, such as chat bubbles, the composer, call
stage and screen-share banner, are built from the same rules:
- Outgoing bubbles use the teal gradient. Incoming bubbles are frosted glass.
- The composer is a frosted pill. The send button is the teal arrow knob.
- Call controls are frosted circular buttons. The end-call button is coral.
- The call stage keeps the tinted canvas instead of going pitch black, except under live video.

## 3. Tokens

All tokens live in `android/app/src/main/java/com/griipbuddy/message/ui/theme/`.

### 3.1 Colour — light

| Token | Value | Use |
|---|---|---|
| `primary` | `#1FB5A6` | CTAs, selection, links, outgoing bubble end |
| `primaryBright` | `#34C8C2` | Gradient start (hero cards, CTA, outgoing bubble) |
| `primaryDeep` | `#12897F` | Accent text on light surfaces, pressed state |
| `primarySoft` | `#D6F3EF` | Tinted icon tiles, selected-row wash, unread chips |
| `onPrimary` | `#FFFFFF` | Text and icons on teal |
| `lavender` / `lavenderSoft` | `#8E7CE0` / `#EEE8FB` | Secondary icon tiles (channels, roles) |
| `peach` / `peachSoft` | `#FF9F7A` / `#FFE6DA` | Warm accents (announcements, mentions) |
| `danger` / `dangerSoft` | `#E5604D` / `#FDE3DE` | Errors, end call, destructive actions |
| `warning` | `#F2A93B` | Reconnecting, pending |
| `success` | `#22B07D` | Online, delivered, connected |
| `canvasTop` → `canvasMid` → `canvasBottom` | `#E6F6F3` → `#F8FBFA` → `#FDEEE6` | Diagonal app background |
| `glass` | `#FFFFFF` @ 72 % | Default card / list surface |
| `glassStrong` | `#FFFFFF` @ 90 % | Sheets, dialogs, composer |
| `glassBorder` | `#FFFFFF` @ 95 % | 1 dp card stroke (the "frost edge") |
| `hairline` | `#13221F` @ 6 % | Rare separators, inactive pill tracks |
| `textPrimary` | `#13221F` | Titles, body |
| `textSecondary` | `#5A6B67` | Descriptions, previews |
| `textTertiary` | `#94A19D` | Timestamps, placeholders, inactive nav |
| `shadow` | `#0E5E57` @ 10–14 % | Soft card shadow (teal-tinted, never grey-black) |

### 3.2 Colour — dark

Dark mode keeps the same structure and swaps in a deep teal-ink canvas.

| Token | Value |
|---|---|
| `primary` / `primaryBright` / `primaryDeep` | `#3DD3C2` / `#4FE0D6` / `#7FE6DA` |
| `primarySoft` | `#16413D` |
| `canvasTop` → `canvasMid` → `canvasBottom` | `#0B1B1D` → `#0E1719` → `#1C1517` |
| `glass` / `glassStrong` | `#1B2E31` @ 72 % / `#1F3336` @ 94 % |
| `glassBorder` | `#FFFFFF` @ 8 % |
| `textPrimary` / `textSecondary` / `textTertiary` | `#E9F3F1` / `#A3B6B2` / `#6E817D` |

### 3.3 Typography

Font: **Plus Jakarta Sans**, a variable font under the SIL Open Font License 1.1, bundled in `res/font`. It shares the
reference's friendly geometric feel and holds up better than a pure geometric face at chat text sizes.

| Style | Size / line | Weight | Use |
|---|---|---|---|
| `display` | 30 / 36 | Bold | Onboarding headline (two-tone: ink + teal) |
| `headline` | 22 / 28 | Bold | Greeting name, profile name, call peer name |
| `title` | 17 / 24 | SemiBold | Centred screen titles |
| `titleSmall` | 15 / 20 | SemiBold | Card titles, conversation names |
| `body` | 15 / 22 | Regular | Message text |
| `bodySmall` | 13 / 18 | Regular | Previews, descriptions |
| `label` | 12 / 16 | Medium | Chips, buttons-small, nav labels |
| `caption` | 11 / 14 | Medium | Timestamps, badges |
| `section` | 13 / 18 | SemiBold | Section headers ("Quick actions" + teal "See all") |

### 3.4 Spacing, shape, elevation

- Spacing uses a 4 dp grid: `xs 4`, `sm 8`, `md 12`, `lg 16`, `xl 20`, `xxl 24`, `xxxl 32`.
  The screen gutter is **20 dp**, card padding 16 dp, the gap between stacked cards 12 dp, and the gap between sections 24 dp.
- Corner radii: hero cards 24 dp, list cards 20 dp, tiles 16 dp, icon tiles 14 dp, and pills fully rounded.
  Message bubbles use 20 dp corners with a 6 dp "tail" corner on the sender side.
- Elevation is a soft teal shadow (8 dp offset, 24 dp blur, 10 % alpha) plus the 1 dp frost border. No hard drop shadows
  and no Material tonal elevation.
- Touch targets are at least 48 dp. Small visual buttons (the 34 dp arrow knob) sit inside a 48 dp hit area.

### 3.5 Iconography and avatars

- Icons are Material Symbols *Rounded/Outlined* line glyphs (Apache 2.0), sized 20–22 dp, coloured by context,
  and placed inside 44 dp rounded tiles tinted with the matching `*Soft` colour.
- Avatars are circles. Without a photo, the avatar is the person's initials on a gradient picked deterministically
  from the user id (teal, lavender, peach and mint families). The ring is 2 dp white, and a 10 dp presence dot sits
  bottom-right (success green or tertiary grey).
- Organisation, branch and team marks are rounded-square tiles with initials.

### 3.6 Motion (rewritten in batch B16, 2026-10-22)

One set of tokens (`ui/theme/Tokens.kt` › `Motion`), chosen by purpose rather than one duration for everything:

| Purpose | Token | Used for |
|---|---|---|
| Immediate feedback | `INSTANT` 90 ms | a leaving list row, the old tab's fade-out |
| Small controls | `QUICK` 160 ms, FastOutSlowIn | selected tab colour, chips, mic ⇄ Send crossfade, a new list row fading in, the reaction row resizing |
| Content | `STANDARD` 220 ms | the tab bar coming back, sheet contents |
| Navigation | `PAGE` 260 ms, emphasized decelerate in and accelerate out | opening a screen (slides from the end edge, a quarter of the width) and Back (reversed); a tab switch is a fade-through (`FADE_THROUGH_DELAY` 60 ms, scale from 0.985), never a slide |
| Entrances | `ENTRANCE` 420 ms | first-run and empty-state illustrations only |
| Placement | spring, medium-low stiffness | list rows sliding to their new place (`listItemMotion`) |

Rules:
- **Motion follows state.** A message animates in when it's in the list, never before; "sent" ticks change only when
  the server answered.
- **Lists:** rows have stable keys and use `listItemMotion()`, so only rows that changed move (a category opening or
  closing, a message arriving). Nothing animates on first load or when a row is edited. A chat follows new messages
  only when you're at the bottom; otherwise the "jump to latest" button appears.
- **Media keeps its space:** photos and videos carry their size (`AttachmentRef.w/h`), so the bubble has its final
  shape before the picture loads.
- **Tabs keep their state:** each tab keeps its back stack and scroll position (`switchTab`: save and restore state,
  single top). Rapid taps can't stack screens.
- **The tab bar** slides away under a screen opened from a tab and back on return.
- **Sheets and dialogs** use Material 3's own motion and gestures (one look everywhere); destructive confirmations
  are plain dialogs that open at once.
- **Calls:** the call screen slides up from a third of the height; camera, screen-share and audio work never waits
  for an animation.
- **Animations off** (Settings › Accessibility › Remove animations, or an animator scale of 0): every transition
  above is instant, including navigation, the tab bar, list rows, the crossfade and resizing
  (`rememberReducedMotion`). The web app follows `prefers-reduced-motion` the same way.
- Motion never blocks input. Nothing loops forever except the "calling…" pulse and the "connecting" shimmer.

### 3.7 States

Every reusable component supports these states:
- `enabled`, `pressed` (scale and darken), `selected` (teal fill, white content), `disabled` (40 % alpha, no shadow)
- `loading` (shimmer or inline progress in the button), `error` (coral text, coral-soft wash)
- `empty` (illustrated orb, title, one-line hint and a primary action)

Connection status uses a slim glass banner under the header: *Connecting…* (warning), *Offline — messages
will send when you reconnect* (tertiary), *Reconnected* (success, auto-hides).

## 4. Screen rules

1. Every screen sits on the gradient canvas. No screen uses a flat white or Material grey background.
2. Every list uses frosted cards, never edge-to-edge Material list items with dividers.
3. The screen header is the centred title pattern: back button in a frosted circle, action in a frosted circle.
   Tab roots (Home, Chats, Workspace, Profile) use a large left-aligned title instead.
4. There is one primary teal CTA per screen at most. Secondary actions are glass pills.
5. The bottom navigation is a floating glass bar with four items. It hides inside conversations and calls.
6. Edge-to-edge: system bars are transparent with dark icons in light mode and light icons in dark mode. Content respects insets
   and the IME. The composer rides above the keyboard.
7. Text never truncates mid-word without an ellipsis. Long names ellipsize at one line in lists and two lines in headers.

## 5. Verification

Rendered screenshots from the emulator are stored in `docs/screenshots/` and discussed in `docs/TESTING.md`
(§ Visual review).
