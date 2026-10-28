# MongoDB in Meldiq (2026-10-19)

How Meldiq moves its server-side data to MongoDB: what lives there today, what stays in SQLite for now and why, how a
domain is migrated, verified and rolled back, and what production still needs. Code: `server/src/mongo/`. Status: **since 2026-10-28 05:20 UTC production keeps seven domains in MongoDB Atlas** (accounts, preferences, history,
reports, relationships, relay, files; API 0.51.1, `docs/DEPLOYMENT.md`); the other six domains stay in SQLite.

## 1. Target architecture

```
Android app ──HTTPS──▶ Meldiq API (Fastify, Hostinger VPS) ──TLS──▶ MongoDB (Atlas or self-run replica set, owner's choice)
   │                        │                                   accounts, account_sessions, account_codes,
   │                        ├── SQLite (WAL, on the VPS)        legacy_tickets, nav_preferences (today)
   │                        │     every other domain (for now)
   │                        └── S3 ap-southeast-1                encrypted file objects (unchanged)
   └── Room + SQLCipher on the phone: cache, outbox, history, keys (device-only)
```

- The app never talks to MongoDB. Credentials live only in the server's environment (`.env`, never Git).
- The API stays the security boundary: every request is authenticated and authorised exactly as before (`authz.ts`).
- S3 keeps the encrypted file objects; the database keeps only their metadata (today in SQLite, `files` domain).
- Message content stays end-to-end encrypted. MongoDB never receives plaintext, private keys, recovery keys or raw
  tokens: the server never has them in the first place (it stores public keys, ciphertext and SHA-256 hashes).

## 2. Domains and where each one lives

A **domain** is a set of tables that moves as a whole (`src/mongo/catalog.ts` › `TABLE_DOMAINS`). Each domain has
exactly one home at a time, recorded in MongoDB (`orbit_meta`, `authority:<domain>`). The server refuses to start in a
state that could split a domain between the stores (`src/mongo/index.ts`):

- a domain listed in `MONGODB_DOMAINS` must have been migrated (unless SQLite has no rows for it yet);
- a domain migrated to MongoDB can't silently go back to SQLite's stale copy (it must be rolled back first).

| Domain | Tables | Home today | Can live in MongoDB |
|---|---|---|---|
| accounts | accounts, account_sessions, account_codes, legacy_tickets | SQLite (prod) | **Yes** (`MongoAccountStore`) |
| preferences | nav_preferences (new 2026-10-19) | SQLite (prod default) | **Yes** (`MongoPreferenceStore`) |
| integrations | *retired 2026-10-21 with the apps (COMMUNITY_REBUILD_2026-10-21.md)*: listed in `MONGODB_DOMAINS` it is ignored; its SQLite tables stay for `admin retired-data` | — | No |
| identity | users, devices, user_blocks, push_endpoints, registration_invites | SQLite | Copy and verify only |
| workspace | orgs, org_members, branches, branch_members, departments, teams, team_members, invitations, org_deletions, audit_log, org_roles, org_role_members, join_applications | SQLite | Copy and verify only |
| conversations | conversations, conversation_members, mention_all_events | SQLite | Copy and verify only |
| relay | delivery_queue, submitted_messages | SQLite (prod default) | **Yes** (`MongoRelayStore`, 2026-10-22, Architecture 1.0 D1: one transaction per accepted message, numeric queue ids from a counter that starts above every SQLite id; tests run on both stores) |
| calls | calls, call_participants, call_hands (split from relay 2026-10-22) | SQLite (prod) | **Yes** (`MongoCallStore`, 2026-10-28: every check-and-write one conditional update; ending a call, mirroring a federated call and retention in one transaction; conversations' call deletes, which SQLite cascades, done by the store; live calls of a list of conversations read once per request) |
| files | attachments, attachment_uploads, abandoned_uploads, pending_blob_deletes | SQLite (prod default) | **Yes** (`MongoFileStore`, 2026-10-22, Architecture 1.0 D2: completing an upload is one transaction; quota sums take uploader and conversation ids from their own modules; S3 objects don't move) |
| history | history_accounts, history_items | SQLite (prod default) | **Yes** (`MongoHistoryStore`, 2026-10-21; `docs/product/MELDIQ_MONGODB_MIGRATION.md` §5) |
| reports | reports | SQLite (prod default) | **Yes** (`MongoReportStore`, 2026-10-21, batch B4; one document per report, no transactions needed) |
| relationships | connections, dm_requests, messaging_settings | SQLite (prod default) | **Yes** (`MongoRelationshipStore`, 2026-10-22, batch B6; one document per pair, request or person; tests run on both stores with `MELDIQ_TEST_MONGO_DOMAINS=relationships`) |
| federation | federation_blocks, federation_domains, federation_inbox, federation_outbox, federation_peers | SQLite | Copy and verify only |

**Never copied** (`EXCLUDED_TABLES`): `auth_challenges` (2-minute nonces), `pairing_requests` (10 minutes, carries the
sealed identity bundle for a new device), `sessions` (v1 token hashes, 7 days; v1 apps sign in again by signature on
their own), `federation_nonces` (replay protection), and SQLite's own `sqlite_sequence` / `schema_migrations`.

### Why only three domains are authoritative in MongoDB

The rest of the server reads and writes SQLite synchronously from about 500 statements spread through the routes, and
authorisation (`authz.ts`) is synchronous on the message hot path. Moving a domain means turning that code async and
replacing SQLite's single-process atomicity with explicit conditional updates and transactions, then proving it with
the full test suite on both stores. That was done for accounts (which already sat behind a store interface), the new
preferences and the new integrations domain (written async from the start, every check-and-write a single conditional
update; its suites run on both stores), and **not** rushed for the rest: a half-moved message path would risk delivery, encryption and calls for
real employees. Each remaining domain follows the same recipe (§6). Every table can already be copied to MongoDB and
verified (`admin mongo-dryrun`), so the data model is proven even where the code isn't moved yet.

## 3. Collections

- One collection per table, same name. A document is the row itself (same field names, so the code's row types fit
  both stores) plus `_id`: the primary key, an object of a composite key's columns (`{ user_id, workspace_id }`), or the
  rowid for the one table without a key (`mention_all_events`).
- **Validators** (`$jsonSchema`, `validationLevel: strict`) and **indexes** are derived from the live SQLite schema by
  `describeTables`, so they can't drift: NOT NULL → required; column types → BSON types; UNIQUE and plain indexes carry
  over; `COLLATE NOCASE` → collation `{ locale: "en", strength: 2 }`; `WHERE col IS NOT NULL` partial indexes → partial
  filters; a UNIQUE nullable column becomes a partial unique index (SQLite allows many NULLs, MongoDB wouldn't).
  A unique partial index with any other condition stops the build until someone maps it by hand.
- JSON text columns become embedded documents (`nav_preferences.doc`). BLOBs become BSON binary (byte-exact).
- Retention: the existing retention job (`jobs.ts`) deletes expired rows in both stores (no TTL indexes: timestamps are
  epoch milliseconds, and the job keeps the one-day grace for ended sessions that a TTL index can't express).
- Schema version: `orbit_meta._id = "schema"` (`MONGO_SCHEMA_VERSION`). Collections and indexes are created or updated
  idempotently at start (`MeldiqMongo.ensureSchema`).

## 4. Concurrency and consistency

- **Single-document conditional writes for every check-and-write**: identity claim (`user_id: null` → id), refresh
  rotation (only if the refresh hash is still the one read; the loser retries and gets the winner's sealed answer), code use (delete only if the hash still matches), session
  revocation, preferences (`rev` compare-and-set). Two concurrent requests can't both win, on either store.
- **Transactions** only where several account documents change together (legacy link). `MeldiqMongo.transaction` carries
  the session through `AsyncLocalStorage`. Accounts in MongoDB require a replica set or Atlas (checked at start).
- **Steps that also write SQLite** (identity rows, invitation uses) are single store methods (`createAccount`,
  `linkIdentity`, `bindDeviceWith`). SQLite runs them in one transaction with the account rows; MongoDB runs them as a
  saga: the SQLite part in its own transaction, and the side that went first is undone if the other fails. A crash in
  between is repaired by the next attempt (`identity.ts › enroll` releases a link to an identity that was never written).
- Reads that combine stores: a session's account comes from MongoDB (`$lookup`, one round trip); the user's and device's
  state from SQLite.
- The WebSocket still re-checks the session on every frame, now asynchronously and in order.

## 5. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MONGODB_URI` | unset | Connection string. Unset: everything stays in SQLite exactly as before. Never logged (redacted). |
| `MONGODB_DB` | `meldiq` | Database name |
| `MONGODB_STORAGE_LIMIT_MB` | `0` (no check) | The deployment's storage limit; `mongo-migrate` and `mongo-dryrun` refuse to start when the projected usage would pass 70% of it (§7a). Set `512` on an Atlas Free (M0) cluster |
| `MONGODB_DOMAINS` | empty | Comma list of domains whose home is MongoDB: `accounts`, `preferences`, `history`, `reports`, `relationships`, `relay`, `files` (`integrations` is retired and ignored) |
| `MONGODB_MAX_POOL` | `20` | Connection pool size (1–200) |
| `MONGODB_TIMEOUT_MS` | `5000` | Server selection and connect timeout; socket timeout is 6× this |

- With `APP_ENV=production`, a non-local `MONGODB_URI` must use TLS (`mongodb+srv://` or `tls=true`), or the server
  refuses to start.
- Writes use `w: majority`, reads `readConcern: majority`, with retryable reads and writes.
- `/healthz` reports `mongodb: true|false|null`; false answers 503.
- **Least privilege** (production): a database user with `readWrite` on the Meldiq database only (no admin roles), the
  network access list limited to the VPS address (72.60.107.88), TLS, and the password only in the VPS `.env`.

## 6. Moving a domain (expand, migrate, switch, contract)

1. **Expand**: deploy a server version that can use MongoDB for the domain, still with `MONGODB_DOMAINS` unset (SQLite).
   Point `MONGODB_URI` at the production database; the server only prepares collections and indexes.
2. **Write freeze**: stop the API container (a short maintenance window; messages wait on the phones' outboxes).
3. **Backups** (§7), then `node dist/admin.js mongo-migrate <domain> --yes`: backs up SQLite first, copies in primary-key
   order in batches with a checkpoint after each, then verifies counts, id sets, each row's content hash and an
   order-independent checksum. Only a fully verified copy becomes the domain's home (`authority:<domain> = mongodb`).
   Re-running is safe (upserts by `_id`); `--prune` removes copies of rows deleted since.
4. **Switch**: add the domain to `MONGODB_DOMAINS`, start the API, run the smoke tests (§8).
5. **Observe**: SQLite's copy stays untouched for the agreed observation period, as the rollback source.
6. **Contract**: only with the owner's explicit approval, empty the domain's SQLite tables (never before).

**Rollback** (any time): stop the API; `node dist/admin.js mongo-rollback <domain> --yes` backs SQLite up, replaces the
domain's tables with MongoDB's documents in one SQLite transaction, checks foreign keys (a dangling reference aborts the
whole restore and changes nothing), verifies, and marks SQLite as the home again; remove the domain from
`MONGODB_DOMAINS`; start the API. MongoDB keeps its copy. An old image that doesn't know MongoDB must only be started
after this step, or it would serve SQLite's stale copy.

**Next domains, in order** (relay and files done 2026-10-22, calls 2026-10-28): conversations + workspace → identity → platform. Federation (off in production, its tables empty there) is ported last. Each needs
its SQL moved behind an async store, `authz.ts` made async where it reads the domain, the full suite run on both stores
(`MELDIQ_TEST_MONGO_DOMAINS`), and a migration rehearsal. Rough size: workspace + conversations ≈ 200 statements (the
largest step, with authorisation). The relay's MongoDB store exists and passes the suite, but it is the message hot
path: its production cutover waits for a load test of sending and acknowledging against the Atlas cluster.

## 7. Backups and recovery

Before any production migration (owner's brief, Part 11.4):

- SQLite: `admin backup` (online snapshot) plus `deploy/scripts/backup.sh`. Today backups stay on the VPS, unencrypted
  (`docs/SECURITY_REMEDIATION.md`): before a migration they must also be **encrypted and copied off the VPS** (for
  example an S3 bucket with SSE-KMS and a separate writer role, or the owner's choice), with counts and the schema
  version recorded. `mongo-migrate` and `mongo-rollback` also write their own snapshot next to the database.
- MongoDB: Atlas continuous backups (M10 or above) or `mongodump --gzip` encrypted off-site for a self-run replica set.
- **Restore drill** in non-production: `mongo-rollback` is covered by tests (`test/mongo_migration.test.ts`), and
  `mongo-dryrun --snapshot <file>` rehearses a full copy of a snapshot into a throwaway database.

## 7a. Capacity (Atlas Free clusters)

An Atlas Free (M0) cluster holds at most 0.5 GB, counted as **uncompressed BSON plus index bytes**, with at most 500
collections and 100 databases, 500 connections, 10 GB in and 10 GB out per rolling 7 days (then throttled), no cloud
backups (`mongodump` works) and possible pausing when idle. A copy that runs out of room halfway is a failed write
freeze, so capacity is measured before anything moves (`src/infrastructure/database/mongo/capacity.ts`):

- `node dist/admin.js mongo-estimate [--domain <d>] [--snapshot <file>] [--limit-mb 512]` reads SQLite only and prints,
  per table, the rows, the BSON bytes of the documents they become (exact: the same `toDocument` the copy uses) and an
  index estimate (key bytes plus 16 bytes per entry, erring high). Exit 1 when the total passes 70% of the limit.
- With `MONGODB_STORAGE_LIMIT_MB` set, `mongo-migrate` and `mongo-dryrun` add what the deployment already holds
  (`dbStats` of every database the user can see), subtract what a re-run overwrites, and refuse before copying when
  the projection passes 70% of the limit. Nothing is written to SQLite or backed up when they refuse.
- A dry run copies every table into a second database: on a Free cluster that doubles the usage and the collection count
  (159 per copy at schema 061, so the server's database plus one rehearsal copy is about 320 of the 500), so run `mongo-dryrun --db meldiq_rehearsal` (a name the database user is granted) and let it drop
  the copy afterwards (no `--keep`).
- Free clusters have no backups: before MongoDB becomes the home of any domain on one, schedule an encrypted
  `mongodump --gzip` off the VPS and keep the SQLite copy untouched (§6.5) as the rollback source.

## 8. Verification and smoke tests

- Automated: `npx vitest run` (SQLite) and `MELDIQ_TEST_MONGO_DOMAINS=accounts,preferences npx vitest run` (the same
  378 tests with accounts and preferences in MongoDB). `test/mongo_migration.test.ts` covers the catalog, validators,
  unique indexes, copying synthetic data (people, an organisation, channels, queued ciphertext, binary history,
  preferences, an Orbit 2.0 account), re-runs, resuming after an interruption, prune, tampering detection, rollback
  (including refusal on broken references), the authority guards and the TLS rule. `test/account_store_races.test.ts`
  covers racing refreshes, double taps, a code used twice, sign-up races, undo and repair, on both stores.
- After a production switch: `/healthz` (mongodb true), sign-in with password, token refresh, device setup on a test
  account, workspace list and selection, preferences read/write, sending a DM and a channel message, a file download,
  `admin mongo-status` counts on both sides, and the error log.

## 9. Data inventory (owner's brief, Part 3)

| Data | Where | Notes |
|---|---|---|
| Private identity and device keys, recovery key | Phone only (Android Keystore-sealed) | Never leave the device; never on any server |
| Message history (plaintext after decryption) | Phone (Room + SQLCipher) | Also as end-to-end encrypted items in server history (`history_items`) |
| Outbox, pending controls, history outbox, quarantine | Phone | Offline queues: preserved on the phone, drained to the API |
| Drafts, local archive, unread counters, call log, call keys | Phone | Per-device state by design (call keys are secrets) |
| Settings, push registration, server profiles | Phone (shared preferences) | Device-local |
| Starred, sections, collapsed groups, mutes | **Server since 2026-10-19** (`nav_preferences`), cached on the phone | Were phone-only; muted flags are merged up once per workspace |
| Selected workspace | Server (`accounts.selected_workspace_id`) + phone cache | |
| Accounts, sessions (hashes), codes (hashes), legacy tickets | Server: SQLite, MongoDB-ready | `accounts` domain |
| Users (public keys, profile), devices (public keys), blocks, push endpoints | Server SQLite | `identity` domain |
| Orgs, members, roles, branches, teams, invitations (hashed codes), audit | Server SQLite | `workspace` domain |
| Conversations and members | Server SQLite | `conversations` domain |
| Queued ciphertext (≤ 7 days), idempotency, calls | Server SQLite | `relay` domain |
| File metadata | Server SQLite | `files` domain; file bytes in S3 (`griipbuddy-orbit-media-sg`) or the VPS disk |
| Encrypted history items | Server SQLite | `history` domain (opaque ciphertext) |
| Profile and organisation photos | S3 (or VPS disk), revision in the users/orgs rows | Not end-to-end encrypted (published by their owners) |
| Federation peers, outbox | Server SQLite | `federation` domain; server keys in a file under DATA_DIR, never in a database |

Production dependencies and risks: one API process (in-memory WebSocket hub), SQLite on one VPS volume, backups on the
same VPS, MongoDB not provisioned, cross-store steps for accounts (sagas, §4), latency of a remote MongoDB on every v2
request (one round trip per authentication, plus one per WebSocket frame).

## 10. Blockers for production (owner)

1. **A MongoDB deployment and credentials**: none exist. Choose Atlas (AWS ap-southeast-1, M10+ for backups) or a
   self-run replica set; create a `readWrite` user for the Meldiq database; allow only the VPS address; give the URI to
   put in the VPS `.env` (piped, never shown).
2. **Encrypted off-VPS backups** of the SQLite database before the migration (§7).
3. **A deploy of the new server version** (it builds from the working tree, which isn't committed).
4. The physical-phone checks against the MongoDB-backed test server (Report A checklist).
