# Profile decorations (API 0.61.0, 2026-10-29)

The owner, 2026-10-29: "need all these + you generate more profile decorations (provide on web and mobile app) and also
user can create and submit by themselves". Decisions asked for and given the same day: community decorations are
**free** (no coin currency), submissions wait for an **operator's review in the admin console**, and **all of Meldiq's
own decorations are free**.

A decoration is a square image whose middle circle (radius 1/1.2 of half its side) is left empty for the avatar. The
apps draw it **1.2 times the avatar's size, centred on it, over the avatar** (under the presence dot). The six classic
frames from API 0.45.0 (`aurora`, `ember`, `frost`, `neon`, `sakura`, `pixel`) stay as they were: the apps draw those
themselves.

Code: `server/src/modules/accounts/decorations/` (service, routes, MongoDB and memory stores, the generated list of
Meldiq's own), `server/src/modules/platformAdmin/decorations.ts` (the review queue), contracts
`server/src/shared/contracts/http/decorations.ts` and the `AdminDecoration*` schemas in `platformAdmin.ts`. Tests:
`server/test/profile_decorations.test.ts` (every case on both stores).

## Meldiq's own

68 decorations drawn for Meldiq in `server/scripts/decorations/` (SVG built in code, nothing traced or copied):
the classics (flames, crown, halo, horns, cat ears, wings, headphones, laurel, snow, hearts, stars, lightning, glow,
rainbow, fire, ice, gold, sparkle, galaxy, neon rings, heartbeat, toxic) and themes people like in community-made
decorations elsewhere, drawn from scratch (starry night, smoke, lace, thorns, blossom, black cats, chains, glitter,
clouds, blood moon, bows, a "gg" bubble, acid, star orbit, circlet, money, crows, bat wings, static, inferno, toast,
shooting stars, moonlit orb, doodle notes, glitch, censored, look here, bubbles, autumn leaves, a gamepad,
**Meldling's ears**, sunflower, vines, roses, ocean, bunny ears, confetti, a gamer headset, a witch hat, mint glow).
Ones built on someone else's brand or character (an operating system's logo, a game's blocks, a meme cat) were left out.

`node scripts/render-decorations.mjs` (in `server/`, needs the `sharp` dev dependency) renders each to
`server/assets/decorations/<id>.webp`: 256 × 256, animated WebP (16 frames, 100 ms) when it moves. It also writes
`assets/decorations/template.png` (the guide for makers) and `src/modules/accounts/decorations/builtins.generated.ts`
(ids, names, whether animated, in the order the apps show them). `--sheet preview.png --sheet-only` draws them all on a
sample avatar without writing files; `--check-edges` lists still ones cut off by the canvas edge. The Docker image
copies `assets/` (`DECORATIONS_DIR` overrides where they're read from).

## Wearing one

`PUT /v1/users/me/profile-style { decoration }` now takes a classic frame, one of Meldiq's own ids, or an approved
community id (`c_` and 16 letters or digits); anything else is `400`. The profile's `profileStyle.decoration` carries
the id. Older apps: Meldiq Web before this drops ids it doesn't know (shows no frame), and the Android app draws a frame
only for the six classic ids, so neither breaks.

## Routes (apps)

| Route | |
|---|---|
| `GET /v2/decorations` | Meldiq's own in order, then approved community ones (newest first), each `{ id, name, kind, animated, imageUrl, creator }`; `classic`; `templateUrl` |
| `GET /v2/decorations/:id/image` | **No sign-in** (profiles are public): Meldiq's own (cached a day) and approved ones (`immutable`, a year); 404 for anything else |
| `GET /v2/decorations/template` | The template PNG, as a download |
| `GET /v2/decorations/mine` | Your submissions with status, reason and wearer count; `artist`, `pendingLimit`, `pending` |
| `GET /v2/decorations/mine/:id/image` | One of your own submissions' images, whatever its status |
| `POST /v2/decorations?name=&original=true` | The image as `application/octet-stream`; `201 { submission }` |
| `DELETE /v2/decorations/mine/:id` | Withdraw yours: a waiting or turned-down one is deleted; an approved one is taken down (below) |
| `GET /v2/users/:id/decorations` | A person's approved decorations, to try on |

`GET /v1/users/:id` carries `decorationArtist: true` for someone with an approved decoration (the **Artist** badge).

### What a submission may be

Recognised by its bytes (`mediaFormats.ts`: PNG, including an animated PNG's frame count, WebP, GIF): square, 128 to
1024 px, at most 1.5 MB and 300 frames. The name is one line of 2 to 32 characters. `original=true` is the maker's
statement that they made it. At most **3 waiting at once, 6 for an artist** (`409 limit_reached`); 20 submissions an
hour per person. Nothing is re-encoded: the file is stored as sent in the `profile-photos` blob store as
`deco-<id>` and served with a fixed content type and `nosniff`.

## Review (admin console)

Permission `decorations.review`: super, operations and support admins.

| Route | |
|---|---|
| `GET /admin/v1/decorations?status=&before=&limit=` | A page of one status (`pending` by default), newest first, with format, size, maker and whether they're an artist |
| `GET /admin/v1/decorations/:id/image` | Any submission's image, with `Content-Security-Policy: default-src 'none'; sandbox` |
| `POST /admin/v1/decorations/:id/decision` | `{ decision: "approve" }`, or `{ decision: "reject" \| "remove", reason }` (8 to 500 characters, the maker sees it) |

Approve and reject apply to a waiting one only, remove to an approved one only (`409 conflict` otherwise, so two
operators can't decide twice). Each decision is audited as `decoration.approve`, `decoration.reject` or
`decoration.remove`. The console's **Decorations** page (Operations) shows each over a sample avatar and on its own
(fetched and shown as a data URL: the console's CSP allows no other images).

**Taking one down** (an operator, or its maker withdrawing an approved one) removes it from the catalog and its public
image, clears it from everyone wearing it (they go back to no decoration, and their contacts' apps hear `user.updated`)
and sets its wearer count to 0. Losing their last approved decoration takes the maker's Artist badge.

## Storage

New data, so **MongoDB whenever the server has one** (`profile_decorations`, indexes `status_created` and
`creator_created`), whatever `MONGODB_DOMAINS` says; the memory store is for development and tests without
`MONGODB_URI`. One document per submission: maker, name, status, format, animated, size, times, reviewer, reason and
`wearers`. The server keeps the approved ones in memory (profiles and the catalog are built synchronously) and loads them
at start. Wearer counts change with each `PUT profile-style` (an update pipeline, never below zero); a failure only
leaves a count stale, and is logged.

## Not built

- **Selling for a currency** ("Shards"): the owner chose free community decorations; Meldiq has no coin to sell for.
- **Telling makers in a notification** when a review is done: they see it under Yours.
- **Removing a deleted account's decorations**: they stay in the catalog with no maker shown; an operator can take one
  down.
