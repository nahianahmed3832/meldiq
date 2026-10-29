# Profile pins (API 0.64.0, 2026-10-29)

The owner, 2026-10-29: "before can multiple pins on profile (these pins belong to community and after completing any
milestone in meldiq, that's means meldiq should have these official pins too!)". Asked how a community's pins reach
people, the owner chose: **a community's owners and admins make pins and give them to members they choose**.

A pin is a small square image shown in a row on a person's profile, beside their name. Two kinds:

- **Meldiq's own**, earned by reaching a milestone. Nobody hands them out: the server works them out from what it
  already knows, each time a profile is built.
- **A community's**, designed by its owners and admins (permission `workspace.edit`, like the community's banner) and
  given to members.

Code: `server/src/modules/accounts/pins/` (the milestones in `builtins.ts`, `service.ts`, `routes.ts`, the MongoDB and
memory stores), the contract `server/src/shared/contracts/http/pins.ts`. Tests: `server/test/profile_pins.test.ts`
(every case on both stores).

## Meldiq's own

| Id | Name | Earned when |
|---|---|---|
| `early-member` | Early member | The account was made before 2027-01-01 (Meldiq's beta) |
| `one-year` | One year | The account is a year old |
| `explorer` | Explorer | A member of 5 or more communities |
| `founder` | Community builder | Owns a community of 10 or more members |
| `spark-giver` | Spark giver | Gives a Meldiq Spark to a community |
| `artist` | Artist | Made a profile decoration Meldiq approved (docs/PROFILE_DECORATIONS.md) |
| `bug-hunter` | Bug hunter | Reported a bug Meldiq fixed (the API 0.46.0 badge) |

They come and go with the milestone (leave communities and Explorer goes; take your Spark back and Spark giver goes).
The images are drawn in code: `node scripts/render-pins.mjs` (in `server/`, needs the `sharp` dev dependency) writes
`server/assets/pins/<id>.webp`, 128 × 128 hexagon badges with a Lucide glyph (ISC licence); `--sheet x.png` draws them
side by side. The Docker image copies `assets/` (`PINS_DIR` overrides where they're read from). The older `badges`
field (`["bug-hunter"]`) stays for older apps.

## A community's own

A square PNG, WebP or GIF (animated is fine), 64 to 512 px, at most 512 KB and 300 frames, recognised by its bytes and
stored as sent in the `profile-photos` blob store as `pin-<id>`. A name of 2 to 32 characters and an optional
description of up to 120, one line each. At most **30 pins per community**; 30 new pins an hour per person.

Giving a pin to someone who isn't a member is `404`; giving it again changes nothing. Taking it back, or deleting the
pin, takes it off their profile, and their contacts' apps hear `user.updated`. Each change is audited: `pin.create`,
`pin.delete`, `pin.award`, `pin.revoke`.

**Who sees it.** A community pin shows on the holder's profile only while they're still a member. From a **public**
community (listed on Discover) everyone sees it; from a **private** one only that community's members (and the holder)
do, so a pin never tells a stranger who is in a private community. At most 24 community pins are shown on a profile,
newest first. Someone the person blocked sees no pins.

## Routes

| Route | |
|---|---|
| `GET /v2/pins` | Meldiq's own, with how each is earned |
| `GET /v2/pins/:id/image` | **No sign-in**: Meldiq's (cached a day) or a community's while it exists (`immutable`) |
| `GET /v2/orgs/:orgId/pins` | Members: the community's pins with holder counts, `canManage`, `limit` |
| `POST /v2/orgs/:orgId/pins?name=&description=` | Owners and admins: the image as `application/octet-stream`; `201 { pin }` |
| `DELETE /v2/orgs/:orgId/pins/:pinId` | Owners and admins |
| `GET /v2/orgs/:orgId/pins/:pinId/holders` | Members: who has it, newest first |
| `PUT /v2/orgs/:orgId/pins/:pinId/holders/:userId` | Owners and admins: give it |
| `DELETE /v2/orgs/:orgId/pins/:pinId/holders/:userId` | Owners and admins: take it back |

`GET /v1/users/:id` carries `pins: [{ id, kind, name, description, imageUrl, animated, community?, since }]` (Meldiq's
first, in their order, then communities'), absent when there are none. Feature: `profile-pins`.

## Storage

New data, so **MongoDB whenever the server has one** (`community_pins`, index `org_created`; `community_pin_awards`,
one document per award keyed `<pinId>:<userId>`, indexes `pin` and `user`), whatever `MONGODB_DOMAINS` says; the memory
store is for development and tests without `MONGODB_URI`. The server holds every pin and award in memory (profiles are
built synchronously) and loads them at start; each change is written to the store first.

## Not built

- **Choosing which pins to show** or their order: all are shown, Meldiq's first.
- **Cleaning up a deleted community's pins**: they stop showing (the community is gone) but stay stored.
- **An invite-friends milestone**: invitations are counted per billing account, which the profile path can't read
  synchronously.
