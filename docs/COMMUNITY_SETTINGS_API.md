# Community parity A3: invite links, links, theme and the onboarding gate

The server side of batch A, part 3, of the web repo's `docs/MELDIQ_COMMUNITY_PARITY.md` (Server Profile, the "Invite
people" dialog, Theme and Onboarding). Additive: one feature name, `community-settings`, migration 071 with four new
tables (no existing table changes), and the API version stays as it is. Code:
`server/src/modules/organizations/settings` (service, custom links, standard links, routes); contracts in
`src/shared/contracts/http/communitySettings.ts`. Tests: `test/community_settings.test.ts` (community tables in SQLite
and in MongoDB). `COMMUNITY_SETTINGS=off` switches it off: the feature name goes, its routes and never-expiring
invitations answer `503 feature_disabled`, custom links stop resolving, nobody is held back, community views leave the
fields out, and what communities set is kept for when it comes back.

| Feature name | What |
| --- | --- |
| `community-settings` | `/v1/orgs/:orgId/settings`, `/v1/orgs/:orgId/invites/standard`, `/v1/orgs/:orgId/onboarding/finish`, never-expiring invitations, custom invite links, the new community view fields |

Tables (workspace domain): `community_settings` (background tint, links, onboarding gate and starting channel),
`community_vanity_invites` (a community's custom link), `community_standard_invites` (each member's standard link and
its code) and `onboarding_completions` (when each member last finished onboarding).

**Settings.** `GET /v1/orgs/:orgId/settings` and `PUT /v1/orgs/:orgId/settings` need the Edit community permission
(`workspace.edit`). The body takes any of `{ name, accent, background, links, inviteSlug, onboardingRequired,
startChannelId }`; fields sent change, `null` clears. Both answer `{ name, accent, background, links, inviteSlug,
inviteSlugMinMembers, memberCount, onboardingRequired, onboardingRequiredSince, startChannelId, updatedAt }`. One write
for everything; audit `community.settings` (the changed fields) and `community.invite_slug` (the new slug or "removed").

- `name`: up to 100 characters (also on `POST /v1/orgs`, `PATCH /v1/orgs/:orgId` and Discord imports; 80 before).
- `accent`, `background`: `#rrggbb`, stored in lower case. Members who'd rather see Meldiq's own theme set
  `communityThemes: false` in their personal preferences (`PUT /v1/me/preferences/personal`); apps that leave the field
  out keep the stored choice.
- `links`: up to 5 of `{ label (1–40), url (https, up to 500) }`.
- `inviteSlug`: 3–32 lowercase letters, digits and hyphens, not starting or ending with a hyphen and not a reserved word
  (`400 invite_slug_invalid`); case is ignored. Claiming or changing it needs 5 members (`403
  invite_slug_needs_members`, `details.minMembers`); another community's slug is `409 invite_slug_taken`. Clearing it
  frees it at once.
- `onboardingRequired`: new members must finish onboarding before they post or react. Turning it on records the time
  (`onboardingRequiredSince`); only members who join from then on are held back.
- `startChannelId`: where people land when they finish; a live text or announcement channel of the community that
  everyone can see (`400 start_channel_invalid` otherwise).

**Invitations.** `POST /v1/orgs/:orgId/invites` takes `expiresInHours: null` (never expires) and `maxUses: null` (no
use limit) for member invitations; admin and guest invitations keep 1 hour to 30 days and 1 to 500 uses (`400`).
Invitation views carry `neverExpires` and `noUseLimit`; their `expiresAt` and `maxUses` then hold a far-future time and a
very large number, so older apps keep working.

`POST /v1/orgs/:orgId/invites/standard` → `{ invite: { id, code, uses, createdAt, neverExpires: true, noUseLimit: true
} }`: the caller's standard link, the one the invite dialog shows. Anyone who may invite members gets one; it is the same
code every time until it stops working (revoked, or its maker can no longer invite), then a new one is made. It goes
when its maker leaves.

**Custom invite links.** A slug is accepted wherever an invitation code is (`POST /v1/invites/preview`, `POST
/v1/invites/accept`, `GET /v1/invites/:code/public`, `/banner` and `/photo`; sign-up takes slugs of 8 or more
characters, its code field's minimum). A real code wins over a slug. It leads to an ordinary member invitation that never expires and has no use limit, so every join rule
applies (bans, paused joining, member limits). Its maker is whoever set the slug last: the link stops working if they can
no longer invite people, until someone who can sets it again. Community views carry `inviteSlug`.

**Onboarding gate.** `POST /v1/orgs/:orgId/onboarding/finish` (members) → `{ onboardingRequired, onboardingDone,
finishedAt, startChannelId, mustFinishOnboarding }`. It needs onboarding questions to be on (`409 onboarding_off`),
every required question answered (`400 answer_required`, `details.promptId`) and, when the community asks for it, its
rules agreed (`403 rules_not_agreed`): the order of the flow. Finishing again moves `finishedAt`. Audit
`community.onboarding_finished`.

While a community has `onboardingRequired` on and asks onboarding questions, plain members who joined since then and
haven't finished get `403 onboarding_not_finished` (`details.orgId`) for messages and for `edit`, `reaction`, `vote` and
`pin` changes anywhere in it, and for bots' slash commands; read markers still go through. This check comes before the
rules agreement. Owners, admins, guests, people who can edit the community and bots are never held back. Someone who
leaves and comes back finishes again.

Community views carry `background`, `links` and `inviteSlug`, and for members `onboardingRequired`, `onboardingDone`,
`startChannelId` (null once that channel can't be one) and `mustFinishOnboarding`. The signed-in invitation preview
carries `background` and `links`.
