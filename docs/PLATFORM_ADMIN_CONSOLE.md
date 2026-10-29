# Platform Admin Console: server side (2026-10-23)

The API behind `https://admin.meldiq.app`, the internal console for Meldiq's operators. Design, audit and decisions:
`/Volumes/code_files/meldiq_central_admin/docs/ARCHITECTURE_PROPOSAL.md` (the console's own repository). Code:
`server/src/modules/platformAdmin/`, migration `046_platform_admin.sql`, contracts
`server/src/shared/contracts/http/platformAdmin.ts`.

**Status: phases 2 (secure foundation), 3 (overview, people, organizations) and 4 (billing status and limits,
infrastructure, incidents, audit viewer, admin management) deployed on 2026-10-23 (API 0.32.0, https://admin.meldiq.app;
docs/DEPLOYMENT.md).** No console admin exists yet: the owner grants the first one with the CLI (below).

## What it is, and isn't

- A separate surface on the existing API process: routes under `/admin/v1/`, registered **only** when
  `ADMIN_CONSOLE_ORIGIN` is set. Without it the server is unchanged.
- Admins are existing Meldiq accounts with a grant in `platform_admins`. Roles: `super_admin`, `operations_admin`,
  `support_admin`, `billing_admin`, `auditor` (permissions: `src/modules/platformAdmin/permissions.ts`, deny by default).
- Separate from `PLATFORM_ADMIN_USER_IDS`, which still switches on the in-app Service health for Android
  (`OPERATIONS.md`). Neither grants anything inside a community.
- It never reads message content, history, queued envelopes, file records or key backups (a test scans the module's
  imports and SQL for them).

## Sign-in

1. `POST /admin/v1/auth/password` `{ email, password }`: the account password, for an account with an active grant.
   Every refusal has the same answer (`401 invalid_credentials`). Limits per network (10 attempts a minute, 10 failures
   in 15 minutes) and per address (5 failures in 15 minutes), separate from the apps' sign-in limits.
2. The browser answers a WebAuthn request for a **console passkey** (relying party = the console's host, user
   verification required). `POST /admin/v1/auth/passkey` → session.
3. The session is a cookie `__Host-mdq_admin` (HttpOnly, Secure, SameSite=Strict, host-only), stored as SHA-256 in
   `platform_admin_sessions`: 15 minutes idle, 8 hours at most. Each request re-reads the grant and the account: a
   revoked grant, a changed role, a disabled account or identity, or a password changed after sign-in ends it.
4. Sensitive actions need a passkey check within the last 5 minutes (`403 reauth_required` →
   `POST /admin/v1/auth/reauth/options`, `POST /admin/v1/auth/reauth`).

Every admin request must carry `X-Meldiq-Admin: 1`, name the console's host in `Host` (nginx sets it;
`X-Forwarded-Host` is ignored), carry no `Authorization` header, and for changes come from the console's exact
`Origin`. Answers are `Cache-Control: no-store` and never carry the apps' CORS headers.

## Data routes (phase 3)

| Route | Permission | |
|---|---|---|
| `GET /admin/v1/overview` | `overview.view` | counts with their sources; health, load and recent admin actions only for roles that may see them; billing "not available" |
| `GET /admin/v1/users?q=&status=&cursor=&limit=` | `users.view` | username prefix, display name, user id; exact email only with `users.view_email`; keyset pages of at most 100 |
| `GET /admin/v1/users/:userId` | `users.view` | identity, account (email only with `users.view_email`), devices, memberships, sign-in and device events, operator interventions; every view audited as `user.view` |
| `POST /admin/v1/users/:userId/suspend`, `/restore` | `users.suspend` / `users.restore` ★ | `{ reason }`; sets or clears `users.disabled_at` and `accounts.disabled_at`; suspending ends every app, v1 and console session and closes connections; idempotent (`changed: false`) |
| `POST /admin/v1/users/:userId/sessions/revoke` | `users.sessions.revoke` ★ | `{ reason }`; ends sessions without suspending |
| `GET /admin/v1/orgs?q=&kind=&cursor=&limit=` | `orgs.view` | name, slug or id |
| `GET /admin/v1/orgs/:orgId` | `orgs.view` | settings, member and role counts, channel counts, owners, 30-day usage, limits; `suspension: { supported: false }` |

★ needs a passkey check within `ADMIN_REAUTH_MINUTES` (`403 reauth_required`) and a reason of 8 to 500 characters.
Nobody can act on their own account, and only a super admin can act on another platform admin (both audited as
`denied`). The read model lives in the owning modules (`accounts/platformQueries.ts`,
`organizations/platformQueries.ts`, `messaging/platformQueries.ts`, `administration/index.ts`); the console never
reads another module's tables itself.

## Operations routes (phase 4)

| Route | Permission | |
|---|---|---|
| `GET /admin/v1/entitlements` | `entitlements.view` | whether a billing provider is configured, entitlement keys, server-wide limits, organizations' own limits in force (with end date and reason) |
| `PUT /admin/v1/orgs/:orgId/limits` | `entitlements.edit` ★ | `{ limits: { key: n \| null }, expiresAt, reason }`; setting a limit needs an end date within 366 days (no end: super admins only); audited with before → after and the end |
| `GET /admin/v1/infrastructure` | `health.view` | checks, load, notable routes, jobs, providers, connectors (setting names only, never values), warnings |
| `POST /admin/v1/connectors/:id/check` | `connectors.check` | `email`, `storage`, `push-fcm`, `mongodb`; sends nothing to anyone; audited |
| `GET /admin/v1/incidents?status=&cursor=` · `GET /admin/v1/incidents/:id` | `incidents.view` | `status=active` means not resolved |
| `POST /admin/v1/incidents` · `PATCH /admin/v1/incidents/:id` · `POST …/notes` · `GET /admin/v1/incidents/assignees` | `incidents.manage` | every change is an event on the incident and an audit row; never deleted; assignees must be admins who manage incidents |
| `GET /admin/v1/audit?actor=&action=&targetType=&targetId=&outcome=&from=&to=&cursor=` | `audit.view` | `action` is a prefix; newest first, paged by row id |
| `GET /admin/v1/audit/verify` | `audit.view` | the hash chain checked end to end |
| `GET /admin/v1/admins` · `GET /admin/v1/admins/:accountId/sessions` | `admins.view` | grants with passkey and session counts, last sign-in, pending enrolment |
| `POST /admin/v1/admins` · `PATCH /admin/v1/admins/:accountId` · `POST …/revoke` · `POST …/reset-passkeys` · `POST /admin/v1/admin-sessions/:id/revoke` | `admins.manage` ★ | grant (answers a one-time enrolment code), role change, revoke, passkey reset (new code), end a session |

Admin management refuses changing one's own access and leaving no active super admin (both audited as `denied`).

## Billing routes (API 0.49.0, `BILLING.md`)

Plans, subscriptions, invoices, provider events and their figures: `/admin/v1/billing/…`, permissions `billing.view`,
`billing.manage` ★ and `billing.events.replay` ★. The full table, the lifecycle and the runbooks are in `BILLING.md`.
The AI Control Center's routes went with AI in API 0.47.0 (`AI_REMOVAL.md`); console 0.7.0 no longer shows it.

## Decoration review (API 0.61.0, `PROFILE_DECORATIONS.md`)

| Route | Permission | |
|---|---|---|
| `GET /admin/v1/decorations?status=&before=&limit=` | `decorations.review` | submissions people sent in, by status (waiting first), newest first |
| `GET /admin/v1/decorations/:id/image` | `decorations.review` | a submission's image, sandboxed |
| `POST /admin/v1/decorations/:id/decision` | `decorations.review` | approve; or turn down / take down with a reason the maker sees; audited as `decoration.*` |

`decorations.review` is granted to super, operations and support admins. The console's page is Operations ›
Decorations.

## Bootstrap (the only way to make the first admin)

There is no HTTP route that creates an admin. With root on the VPS:

```bash
docker compose -p griip-internal-messaging -f /opt/griip-internal-messaging/compose.yaml exec api node dist/admin.js platform-admin-grant person@example.com super_admin "owner"
```

It prints a one-time **enrolment code** (shown once, valid 30 minutes, 5 tries). The person opens the console's
enrolment page, signs in with their password and the code, and registers a console passkey. Other commands:

| Command | |
|---|---|
| `platform-admin-list` | every grant, active or revoked, and its passkey count |
| `platform-admin-revoke <email> [reason]` | revoke a grant and end its console sessions |
| `platform-admin-reset-passkeys <email> [reason]` | lost device: remove console passkeys, end sessions, print a new code |
| `platform-audit-verify` | check the platform audit's hash chain end to end (exit 1 if broken) |
| `ai-workforce-status` | AI switches and jobs by state (no content) |
| `ai-workforce-pause <reason>` · `ai-workforce-resume <reason>` | emergency stop for new AI jobs, audited; the running server obeys it at its next tick |

Running `platform-admin-grant` again with another role changes the role and ends that admin's sessions.

## Audit

`platform_audit` is append-only (SQLite triggers refuse UPDATE and DELETE) and hash-chained (each row's hash covers the
previous row's hash and its own fields). The retention job never prunes it. Rows: sign-ins (success, failure, denial,
throttling), enrolment, re-authentication, sign-out, sessions ended by a change, permission denials, grants, role
changes, revocations and passkey resets, with the actor, role, target, outcome, reason, request id and network
(IPv4, or the IPv6 /64). Never passwords, tokens, codes, passkey material, message content, or the address an unknown
sign-in typed (a hash prefix only). Someone with root on the VPS can still drop the triggers: the chain makes an edit
detectable, and keeping the last hash off the VPS (for example in the backup manifest) makes it provable.

## Settings (`deploy/.env.example`)

| Variable | Default | |
|---|---|---|
| `ADMIN_CONSOLE_ORIGIN` | unset | `https://admin.meldiq.app`. Unset: no console routes. `http://localhost:<port>` is accepted for local development |
| `ADMIN_SESSION_IDLE_MINUTES` | 15 | 5 to 60 |
| `ADMIN_SESSION_MAX_HOURS` | 8 | 1 to 12 |
| `ADMIN_REAUTH_MINUTES` | 5 | 1 to 15 |
| `ADMIN_ALLOWED_NETWORKS` | unset | CIDR list; when set, other networks get 403 (the owner's plan: a VPN later) |

`validate-env.sh` checks `ADMIN_CONSOLE_ORIGIN`.

## Database (migration 046, additive)

`platform_admins`, `platform_admin_passkeys`, `platform_admin_enrolments`, `platform_admin_challenges`,
`platform_admin_sessions`, `platform_audit`, `platform_incidents`, `platform_incident_events`. SQLite in every mode
(MongoDB catalog domain `platform`, copy and verify only; sessions, ceremonies and enrolment codes are never copied).
Older API images run on this schema unchanged. The retention job removes ended console sessions after a day and
expired ceremonies and codes.

## Tests

`server/test/platform_admin_auth.test.ts` (gate, enrolment, sign-in, refusals, throttling, sessions and what ends
them, step-up, CLI, audit immutability and chain verification) and `server/test/platform_admin_permissions.test.ts`
(the role table, deny by default, the module's imports and SQL), and `server/test/platform_admin_data.test.ts` (overview,
people, organizations, permissions per role, step-up, suspension end to end), and
`server/test/platform_admin_ops.test.ts` (limits, infrastructure, incidents, the audit viewer, admin management and its
escalation rules). The console has its own unit and browser tests.
