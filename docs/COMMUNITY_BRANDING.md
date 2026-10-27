# Community branding (API 0.44.0)

A community can have its own **accent colour** and **banner**. Without them it uses Meldiq's standard theme; nothing
changes for existing communities until someone picks one.

## What's stored

| Column (`orgs`) | Meaning |
|---|---|
| `accent` | `#rrggbb` in lower case, or `NULL` for Meldiq's theme |
| `banner_rev` | the banner's revision, or `NULL` without one |

Migration `057_community_branding.sql` only adds these two nullable columns. The banner is a JPEG in the existing
`profile-photos` blob store (local disk or S3, whichever the server uses), named `<orgId>_banner-<rev>`, beside the
community photo. A new banner gets a new revision and the old blob is deleted; deleting the community queues its banner
for deletion with its photo. `admin storage-orphans` knows banner blobs (and, since this release, community emoji and
stickers) so it never reports them as orphans.

## API

| Route | Who | Notes |
|---|---|---|
| `PATCH /v1/orgs/:orgId` `{ accent }` | `workspace.edit` (owners, admins, roles with it) | `#rrggbb` or `null`; anything else is 400 |
| `PUT /v1/orgs/:orgId/banner` (JPEG body) | `workspace.edit` | at most 1 MB, must be a JPEG; the web sends 1200 × 480 |
| `DELETE /v1/orgs/:orgId/banner` | `workspace.edit` | |
| `GET /v1/orgs/:orgId/banner` | members; anyone signed in if the community is public (Discover shows it); never someone banned | 404 without one |
| `GET /v1/invites/:code/banner` | anyone with a usable invitation code (rate limited) | for the invite page and the app's preview |

`accent` and `bannerRev` are part of every community view (`GET /v1/orgs`, `GET /v1/orgs/:orgId`, the Discover list,
the community preview, the signed-in invitation preview). The public invitation answer (`GET /v1/invites/:code/public`)
carries `accent` and `banner: true|false`. Changes are audited (`org.accent`, `org.banner`) and members are told with
`org.updated`. The server advertises `community-branding`.

Like the community's name and photo, the accent and banner aren't end-to-end encrypted: the server stores them.

## Readability

The server accepts any `#rrggbb`. The apps make it readable rather than refusing colours: text on the accent is black or
white, whichever contrasts more (a mid-tone that reaches neither 4.5:1 is deepened or lightened just enough), and text in
the accent is moved towards black on light surfaces and towards white on dark ones until it reaches 4.5:1 (meldiq-web
`src/ui/community/accent.ts`, with tests). The accent is scoped to the surfaces that show that community (its channel
list, its rail icon, its cards and invitation), never to the app's theme, so one community can't recolour another or
Meldiq itself.

## Apps

- **Web** (meldiq-web): Community settings › Overview › Appearance (presets, any colour, banner upload with preview,
  Save and Cancel; read-only preview for members who can't edit); the channel list's selected channel and header, the
  rail icon's ring, Discover cards, the invitation preview and the public invite page.
- **Android:** not yet. The new fields are additive and the app ignores unknown fields, so nothing breaks.
