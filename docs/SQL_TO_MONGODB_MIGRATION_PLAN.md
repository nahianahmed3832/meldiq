# SQL to MongoDB: migration plan (2026-10-28)

A plan only. **Nothing here has been run.** Production stays on SQLite (schema 60, API 0.48.0) until the owner starts
this work. It brings `docs/MONGODB.md` (the design, 2026-10-19) and `docs/ORBIT_MONGODB_CUTOVER_PLAN_2026-10-19.md` up
to date with what the server and production look like now. Those documents keep the details of the store adapters,
validators and the Atlas setup; this one is the order of work.

## 1. Where things stand

| Fact | Value | Source |
|---|---|---|
| Production database | SQLite (WAL) on the VPS, 49 MB, schema 60, 164 tables (95 of them empty), 43 users | backup `pre-0.47.0-20261027T161806Z` (`verify.json`, row counts read from a temporary copy) |
| Largest tables | `resource_samples` 322,535 rows · `delivery_queue` 15,263 · `resource_hourly` 5,551 · `presence_samples` 5,465 · `history_items` 1,948 · `submitted_messages` 1,856 · `conversation_members` 891 · `audit_log` 708 | same |
| Files | Encrypted objects in S3 (and older ones on the VPS disk); the database keeps only their metadata | `docs/STORAGE_AND_DATA.md` |
| MongoDB code | Every table is classified into a domain (`src/infrastructure/database/mongo/catalog.ts`, `TABLE_DOMAINS`); short-lived security tables are excluded on purpose (`EXCLUDED_TABLES`); a test fails when a new table isn't classified. Validators and indexes are derived from the live SQLite schema | catalog.ts, `test/architecture_boundaries.test.ts` |
| Running against MongoDB | Seven domains have MongoDB stores beside their SQLite ones: accounts, preferences, relationships, files, history, relay, reports (`src/modules/**/mongo*Store.ts`, chosen per request by `ctx.mongo.owns(domain)`). Identity, workspace, conversations, calls, federation and platform are SQL-only: they can be copied and verified, not served | the stores; `src/admin.ts` |
| Credentials | None in this repository. `MONGODB_URI` would go into the API's `.env` on the VPS with hidden input (cutover plan §1) | — |

So the honest size of "move to MongoDB" is: seven domains have stores today (one of them, accounts, has new tables that
bypass its store, §2); the other six, including the busiest (identity, conversations, workspace), need their SQL
rewritten behind a store interface first. The data itself is small; the work is in the code.

## 2. Domains and collection mapping

One collection per table, documents are the rows (same field names) with `_id` = the primary key, as `catalog.ts` does
it. A domain moves as a whole.

| Domain | Tables | Rows (prod) | Notes for the move |
|---|---|---|---|
| accounts | 15 (accounts, sessions, codes, recovery, key backups, passkeys, TOTP, email changes, warnings, bug reports, `legacy_tickets`) | small | Stores exist, **but** the tables of migration 060 (TOTP, email changes, warnings, bug reports; API 0.46.0) are read and written with SQL directly (`modules/accounts/totp.ts`, `emailChange.ts`, `standing.ts`, `bugReports.ts`). Moving `accounts` before those go behind the store would split the domain: do that first |
| preferences | nav_preferences | small | Store exists |
| identity | users, devices, blocks, push endpoints, reminders, invites | 43 users, 88 devices | Needs a store; most-read domain (every request resolves the user) |
| workspace | 46 tables (communities, roles, categories, onboarding, Discord import, documents, meetings, inbox, entitlements…) | audit_log 708, channel_categories 37 | Largest code surface; many tables are empty in production (old workspace features) |
| conversations | conversations, members, mention_all_events | 207 / 891 | Hot path with relay; `conversationView` joins categories and calls (see §4) |
| relay | delivery_queue, submitted_messages | 15,263 / 1,856 | Store exists. Encrypted envelopes only; high write rate; TTL 7 days. Move last, or keep on SQLite |
| calls | calls, participants, hands | 112 / 202 | Small |
| files | attachments, uploads, abandoned uploads, pending deletes | 256 | Store exists. Metadata only; S3 unchanged |
| history | history_accounts, history_items | 1,948 | Store exists. Encrypted history backups |
| reports, relationships | 1 + 3 tables | small | Stores exist |
| federation | 5 tables | small | Needs a store |
| platform | 47 tables (admin console, telemetry, quotas, alerts) | resource_samples 322,535 | Telemetry: consider not migrating raw samples at all (rollups only), see §5 |
| integrations | 10 tables | 0 | Retired 2026-10-21; never migrate |

## 3. Order of work

1. **Owner decisions** (§6): Atlas tier and region, backups, who runs the cutover window.
2. **Code first, on SQLite**: put the accounts tables of migration 060 behind the accounts store, then every SQL-only
   domain behind a store interface, each with a SQLite and a MongoDB implementation and one shared test suite run
   against both. Switch order: preferences, reports, relationships, files, history (stores exist), accounts (after the
   060 tables), then calls, federation, identity, conversations, workspace, platform as their stores land; relay last or
   never.
3. **Rehearse on a copy**: restore a production backup into a scratch SQLite, `node dist/admin.js mongo-dryrun`, then
   `mongo-migrate <domain>` into a throwaway MongoDB and `mongo-verify <domain>` (row counts, per-document comparison,
   indexes). `mongo-status` shows each domain's home; `mongo-migrate` and `mongo-rollback` back SQLite up first, want
   `--yes` and the API stopped.
4. **Dual-run in staging**: the API with `MONGODB_DOMAINS=<domain>` against a staging MongoDB, the full server suite
   and the Android and web browser suites against it.
5. **Cutover window** (production, owner present): backup → migrate → verify → switch `MONGODB_DOMAINS` for that domain
   → health checks and smoke tests → observe. One domain (or one small group) per window.
6. **Observe** a week per step before the next domain; SQLite's copy is kept read-only until then.

## 4. Verification checklist (each domain, each window)

- [ ] Backup taken and verified (`scripts/backup.sh`, `verify.json` ok, integrity ok) and copied off the VPS.
- [ ] Row count per table equals document count per collection.
- [ ] Every document compared field by field with its row (types: integers stay integers, BLOBs become `Binary`).
- [ ] Unique and partial indexes present; a duplicate insert is refused as in SQLite.
- [ ] The API's contract tests pass against MongoDB for that domain (`npm test` with `MONGODB_DOMAINS`).
- [ ] Ordering is unchanged where the apps depend on it: channel `position`, category `position` (and the
      `categoryPosition` every channel now carries), message `server_ts`, rail order in preferences.
- [ ] Production smoke: sign in, DMs and channels, send and receive, an encrypted upload and download, invitations,
      calls, the Android app against the same server.
- [ ] No plaintext anywhere: MongoDB receives what SQLite holds today (public keys, ciphertext, hashes), nothing more.

## 5. Rollback

- Before a domain is switched: drop its collections; nothing else changed.
- After: `mongo-rollback <domain>` copies MongoDB's rows back into SQLite (the authority record in `orbit_meta`
  prevents serving SQLite's stale copy by accident), then `MONGODB_DOMAINS` without that domain and a restart. If that
  fails: restore the pre-window SQLite backup (writes since the window are then lost; keep windows short).
- The API image of the previous release is kept tagged (`<version>-rollback`) as for every deploy.

## 6. For the owner

- Atlas (or self-run replica set), tier with continuous backups, region near the VPS, IP allow-list for the VPS only.
- Whether raw telemetry (`resource_samples`, `presence_samples`, ~330k rows, 7–30 days' retention) migrates or only
  its hourly rollups.
- Whether `relay` moves at all (it's a queue; SQLite on local disk is fast and simple for it).

## 7. Data that could be retired during the migration (not deleted now)

Nothing below was dropped; every table is still in the database and the backups.

| Data | Why it may go | Before dropping |
|---|---|---|
| `ai_*` tables (26) and AI settings | AI and AI Workforce were removed in API 0.47.0 (`docs/AI_REMOVAL.md`); unread since | Export if the owner wants an archive |
| `integration_*` tables (10) | Apps retired 2026-10-21 | Already empty in production |
| `legacy_tickets` | The web no longer offers moving a pre-email account (web brief v4 §13); Android may still | Confirm the Android app no longer calls `/v2/migration/legacy/*` |
| `sessions` (v1) and device-key sign-in | The web no longer offers phone-only sign-in in release builds; Android still signs devices in this way where it does | Keep while any app version uses it |
| Old workspace tables (branches, departments, teams, documents, inbox, workflows…) | Empty or nearly; communities replaced workspaces | Confirm no app reads them |

Safety numbers had no server-side data: they were computed in the apps from public identity keys, which stay (they are
how messages are encrypted to the right people).
