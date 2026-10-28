# MongoDB Atlas Free for Meldiq: setup and migration report (2026-10-28)

Owner's brief: a separate, free Atlas environment for Meldiq (project `Meldiq`, M0 cluster `Meldiq-Free`, database
`meldiq`), a verified migration of Meldiq's SQL data, the shared backend on MongoDB, GriipBuddy untouched.

**Outcome (round 2, verified): the Atlas cluster does NOT exist yet and NO data was migrated to Atlas.** The
restricted Atlas identity can read the `Meldiq` project but can't create anything (§1, B1). Everything else is
verified: the production SQLite source was measured read-only (31,703 rows → 25.84 MiB estimated, about 5% of the Free
limit), and a full migration of a production snapshot into a local throwaway replica set copied and verified all 159
tables. The backend, the production web build and the Android unit suite were then tested against it (§5b). Production
is unchanged (API 0.50.0 on SQLite); no cutover, nothing destructive.

## 1. Blockers (owner)

Round 1 (earlier on 2026-10-28) was blocked on Atlas org access and on production reads. Both were resolved for round 2:
the org's AI access works now, and the source was read read-only at your request. What still blocks:

| # | Blocker | Exact missing permission or credential | Evidence |
|---|---|---|---|
| B1 | **The `Meldiq-Free` cluster can't be created by Claude.** The restricted Atlas identity sees org *Hainan Haikou Shangfen Technology Private Limited* (`68c25d8f…45e2`) and project `Meldiq` (`6ae161ca048ef3c4ee51a477`, created 2026-10-28 02:45, empty: 0 clusters, 0 database users, 0 access-list entries). Neither Atlas MCP server offers a write tool: both expose only list, inspect, regions, alerts, performance advisor, stream discovery and connect. | A **create-capable Atlas client** for the `Meldiq` project: the MongoDB MCP server with write tools enabled (not read-only mode) **plus** an identity holding *Project Cluster Manager* (cluster), *Project Database Access Admin* (database user) and *Project IP Access List Admin* (access list) on `Meldiq` only, **or** you create them in the Atlas UI (§6 steps 2–5, about 10 minutes). | `atlas-list-projects`, `atlas-list-clusters`, `atlas-list-db-users`, `atlas-inspect-access-list`, tool search for `atlas create` (2026-10-28) |
| B2 | **Database user password / connection string** | A `readWrite@meldiq` + `readWrite@meldiq_rehearsal` SCRAM user created by you; its URI goes into the VPS `.env` without being shown (§6 step 6). Claude doesn't handle passwords in plain text. | — |
| B3 | **Go-ahead for VPS changes**: deploying API 0.51.0 (the capacity tooling) and the `.env` lines | Your explicit go-ahead (standing rule for VPS `.env` and deploys) | — |

GriipBuddy: **not touched.** In Atlas, only the org list and the `Meldiq` project were inspected. "Project 0" (the
org's only other project, created 2025-09-11) was listed by name and never queried. On the VPS, which also runs the
GriipBuddy containers (`griipbuddy-server`, `-admin`, `-frontend`, `-dev-server`, two Redis, the employee app and its
Postgres), commands ran only in `griip-internal-messaging-api-1`. Meldiq's code has no reference to GriipBuddy's
database.

## 2. Source audit

| Item | Finding |
|---|---|
| Engine and location | SQLite 3 (better-sqlite3 13.0.3, WAL), one file under `DATA_DIR=/data` in the `api` container on the Hostinger VPS 72.60.107.88 (Docker volume `api-data`). One process, one writer. |
| Schema | 61 migrations (`server/migrations/001_init.sql` … `061_billing.sql`); 172 tables, of which 159 map to collections and 13 are excluded by design (sign-in nonces, sessions, per-minute samples, SQLite bookkeeping: `catalog.ts › EXCLUDED_TABLES`). |
| Data access | Only the API server. Web (`orbit_web`), Android and the admin console use the HTTPS API; none reads a database directly. Android keeps its own Room/SQLCipher cache on the phone (device-local by design, never migrated). |
| Files | Attachment bytes are end-to-end encrypted objects in S3 (`griipbuddy-orbit-media-sg`, ap-southeast-1) or on the VPS disk; the database holds metadata only. MongoDB gets the metadata, never the files. |
| Environments | Production (VPS), local development (`DATA_DIR`), tests (in-memory SQLite + a local MongoDB replica set). No staging server. |
| Source identity (verified) | Container `griip-internal-messaging-api-1` (image `griip-internal-messaging-api:0.50.0`), file `/data/griip.sqlite`, schema 061. Read with `better-sqlite3` `readonly: true` only. |
| Size (measured, read-only) | File 56.3 MB (+ 4.5 MB WAL), no free pages, `quick_check` ok, 0 foreign-key violations, no unclassified tables. 159 mapped tables hold **31,703 rows** in 64 non-empty tables. Most of the file is excluded telemetry (`resource_samples` 359,594 rows, `presence_samples` 6,093). |
| Largest tables | `delivery_queue` 17,686 rows (12.46 MiB + 5.73 MiB indexes), `history_items` 2,008 (2.35 + 0.83), `resource_hourly` 6,161 (0.84 + 0.91), `submitted_messages` 2,052 (0.59 + 0.21), `audit_log` 791, `conversation_members` 648, `attachments` 285. Largest single document 12.6 KB. |
| Projected MongoDB size | **25.84 MiB** (17.34 documents + 8.50 indexes, estimate) = 5% of 512 MiB; the guard's threshold is 358.4 MiB. Measured after a real copy: **20.3 MiB** (17.37 data + 2.97 indexes). |
| Region | From the VPS (Malaysia): AWS `ap-southeast-5` Malaysia 2 ms, `ap-southeast-1` Singapore 8 ms, Jakarta 21 ms, Hong Kong 36 ms, Mumbai 62 ms, Europe 160–170 ms, us-east-1 233 ms (TCP connect, 3 samples). |

## 3. What already existed (not rebuilt)

The server already carries a complete SQLite→MongoDB path, designed 2026-10-19 to 10-22 (`docs/MONGODB.md`):

- **Schema mapping** (`catalog.ts`): one collection per table, same field names, `_id` = primary key (composite keys
  as an embedded object). `$jsonSchema` validators and indexes are derived from the live SQLite schema: NOT NULL →
  required, types → BSON types, `COLLATE NOCASE` → case-insensitive collation, nullable UNIQUE → partial unique index,
  JSON text → embedded documents, BLOB → BinData. Timestamps stay epoch-millisecond integers (no TTL indexes; the
  retention job deletes in both stores).
- **Migration** (`migrate.ts`): keyset batches of 500 in primary-key order, a checkpoint per batch (resume after an
  interruption), upserts by `_id` (re-runs never duplicate), optional `--prune`, then verification of counts, id sets,
  per-row SHA-256 and an order-independent checksum. A row the validator refuses fails the batch loudly; nothing is
  skipped. Logs carry counts and checksums only, never content (message bodies are ciphertext anyway).
- **Authority guards**: each domain has exactly one home, recorded in `orbit_meta`; the server refuses to start in a
  state that could split a domain. `mongo-migrate` backs SQLite up first; `mongo-rollback` restores in one SQLite
  transaction and checks foreign keys.
- **Backend on MongoDB, per domain**: accounts, preferences, history, reports, relationships, relay and files have
  async MongoDB stores and pass the full test suite with MongoDB as their home.
- **Not ported** (roughly 800–850 synchronous SQL statements, counted by module): identity, workspace (organisations, channels, roles,
  communities), conversations, calls, federation and platform (admin console, telemetry, quotas, billing). These can be
  copied and verified (`mongo-dryrun`) but their code still reads SQLite. Authorisation (`authz.ts`) is synchronous on
  the message path; porting it is the largest step and was deliberately not rushed (§2 of `MONGODB.md`).

So a production move today is per domain: the seven ready domains to MongoDB, everything else stays in SQLite.
"Every table in MongoDB" is a further, multi-week porting effort.

## 4. Changes made today

All in `meldiq_android/server` (branch `internal-beta` checkout, **uncommitted**, not deployed):

| File | Change |
|---|---|
| `src/infrastructure/database/mongo/capacity.ts` (new) | Storage estimate before copying: each row measured as the exact BSON document it becomes plus its index entries; projection against the live deployment (current `dbStats` usage, minus what a re-run overwrites); refuses past 70% of the limit. |
| `src/infrastructure/database/mongo/admin.ts` | New `mongo-estimate [--domain] [--snapshot] [--limit-mb]` (reads SQLite only). `mongo-migrate` and `mongo-dryrun` check capacity before copying when `MONGODB_STORAGE_LIMIT_MB` is set (no backup, no copy when they refuse). `mongo-dryrun --db <name>`: a least-privilege user can't create the random `meldiq_dryrun_*` database. |
| `src/infrastructure/database/mongo/config.ts` | `MONGODB_STORAGE_LIMIT_MB` (default 0, no check). |
| `src/infrastructure/database/mongo/migrate.ts` | `sourceBatches` exported (shared by the estimate). |
| `src/admin.ts` | Usage comment. |
| `test/mongo_capacity.test.ts` (new) | 8 tests: estimate equals MongoDB's stored size per collection, projection, re-runs not double-counted, refusals copy nothing and leave no database. |
| `docs/MONGODB.md` | §7a Capacity (Free cluster limits), `MONGODB_STORAGE_LIMIT_MB`, `MONGODB_DB` default corrected to `meldiq`. |

No web, Android or console change is needed: the API and its responses are unchanged in every mode.

## 5. Test results (local, 2026-10-28)

Server only (web, Android and console weren't changed and weren't re-run). MongoDB runs use a local 3-node replica
set (`mongodb-memory-server`), not Atlas. There is no server lint script.

| Run | Before the change | After the change |
|---|---|---|
| Typecheck (`tsc --noEmit`) | pass | pass |
| Full suite, SQLite | 979 passed, 10 skipped | 986 passed, 1 failed, 10 skipped |
| Full suite, seven domains in MongoDB (`MELDIQ_TEST_MONGO_DOMAINS=accounts,preferences,history,reports,relationships,relay,files`) | 966 passed, 1 failed, 1 file's setup timed out, 22 skipped | 984 passed, 3 failed, 10 skipped |
| `test/mongo_capacity.test.ts` (new) | — | 8 passed |

Every failure is a timing test under full-suite load, and each passed when its file was re-run alone:
`mongo_migration` "can run again…" (60 s timeout, both runs; alone 14/14), `platform_admin_insights` setup (20 s hook
timeout; alone passed), `ordering` burst and backlog tests (relay in MongoDB; a 232-message burst had received 166 at
the deadline; alone 3 of 3 runs 2/2), `presence_stability` grace period (SQLite; alone 2 of 2 runs 6/6). None touches
the files changed today. The ordering result is the one to watch on a real cluster: it is the relay hot path, and the
cutover plan already holds relay back until a load test against Atlas.

## 5b. Round 2: rehearsal on a production snapshot (verified, 2026-10-28)

Not against Atlas (no cluster exists, B1): into a **throwaway local 1-node MongoDB replica set** (WiredTiger on disk,
started from the server's `mongodb-memory-server`), on this Mac.

**Snapshot.** `VACUUM INTO /tmp/meldiq-rehearsal.sqlite` from a `readonly: true` connection inside the API container
(production's `/data` untouched), streamed over SSH, SHA-256 identical on both sides
(`4687a087…4ef0`, 50.7 MB), then deleted from the container. Locally in a `0700` scratch folder; deleted after the
rehearsal (§8).

| Step | Result |
|---|---|
| `mongo-estimate --limit-mb 512` | 159 tables, 31,703 rows, 17.34 + 8.50 = 25.84 MiB, **fits** (exit 0) |
| `mongo-dryrun --snapshot … --db meldiq_rehearsal` (all 159 tables, with `MONGODB_STORAGE_LIMIT_MB=512`) | Guard: 1.72 MiB used, 27.57 MiB projected, fits. **First run verified, second run verified, re-run identical.** 0 tables with `ok=false`: counts, id sets, per-row hashes and checksums match for every table; strict validators accepted every document (0 rejected). 18.7 s locally. |
| Actually stored (before dropping `meldiq_rehearsal`) | 160 collections (of the 500 a Free cluster allows), 440 indexes, dataSize 17.37 MiB, indexSize 2.97 MiB → **20.3 MiB, about 4% of 512 MiB**. The estimate is exact for documents and errs high for indexes, as designed. |
| `mongo-migrate <domain> --yes` × 7 into `meldiq` (accounts, preferences, history, reports, relationships, relay, files) | Each: guard passed, SQLite copy backed up, copied, **verified: every table matches**, authority recorded as `mongodb`. About 14 s in all. `mongo-status`: transactions true; counts equal on both sides (e.g. accounts 19, account_sessions 35, history_items 2,008, delivery_queue 17,686, submitted_messages 2,052, attachments 285, connections 6, nav_preferences 4). |
| Server on the migrated copy, all seven domains in MongoDB (temporary vitest smoke test, removed afterwards) | **4/4 passed**: start-up authority guards accept the migrated state; `/healthz` mongodb true; account sign-up, sign-in, refresh (+1 account document); a DM and a channel message delivered over WebSocket in send order (10/10); preferences write/read; encrypted history write/read; every migrated document still present. |
| Web, production build `f78407e` (worktree), against the API with all seven domains in the local replica set | Typecheck pass. Unit tests 530 passed, 1 skipped; exit 1 from one unhandled rejection in a client-side crypto unit test ("attachment decryption failed"), which doesn't reach the server. **Browser e2e (Chromium): 69 passed, 3 skipped (touch/phone-only and update-banner specs), 0 failed** in 10.2 min. Confirmed in MongoDB afterwards: all seven domains recorded as `mongodb`; the e2e run wrote 349 queue entries, 303 submissions, 6 accounts, 12 sessions, 6 attachments, 4 preference sets, 2 connections. |
| Android | §5c |

Not verified: Atlas itself (network latency, M0 throttling, TLS/SRV), the remaining six domains in MongoDB (their code
still reads SQLite), Firefox/WebKit e2e, and the Android app on a device against a MongoDB-backed server.

## 5c. Android

`./gradlew testDebugUnitTest` (JDK: Android Studio's bundled JBR; no system Java is installed): **734 tests, 0
failures, 0 errors, 0 skipped**. The working tree includes someone else's uncommitted `android/app/build.gradle.kts`
change (2 lines), left as is. These JVM tests check the app against the API contract with `MockWebServer`; they don't
reach a server. The Android app never touches a database on the server: it only calls the HTTPS API, whose responses
are identical in either store mode (the server suite's contract observer checks every response, on both stores). An
on-device run against a MongoDB-backed server (emulator `Medium_Phone_API_36.1` exists) was not done.

## 5d. Round 3: rehearsal against Atlas (verified, 2026-10-28 04:10–04:20 UTC)

From the VPS, in one-off `griip-internal-messaging-api:0.51.0` containers reading `.env` (FCM and MongoDB lines left out)
plus `.env.mongodb`, on a copy of backup `pre-0.51.0-20261028T032724Z` (never `/data`); production API untouched.

| Step | Result |
|---|---|
| Connection (`mongo-status`) | `meldiq_api` authenticated; **transactions: true**; round trip **7.7 ms median, 8.2 ms slowest** (10 pings, VPS → AWS Singapore); every domain recorded as SQLite, MongoDB counts 0 |
| Egress | VPS host and its containers leave from `72.60.107.88`, the access-list entry |
| `mongo-estimate --limit-mb 512` | 159 tables, 31,521 rows: 17.21 + 8.44 = **25.65 MiB, fits** |
| `mongo-dryrun --db meldiq_rehearsal` (guard `MONGODB_STORAGE_LIMIT_MB=512`) | Guard: 1.76 MiB used, 27.41 MiB projected, fits. **First run verified, second run verified, re-run identical; 318/318 table checks ok, 0 failed** (e.g. `delivery_queue` 17,485, `history_items` 2,008) |
| Stored on Atlas (measured before cleanup) | 160 collections, 31,681 documents, dataSize **17.23 MiB**, indexSize **11.53 MiB** → **28.76 MiB = 5.6% of 512 MiB**; storageSize 9.07 MiB compressed. Atlas reports indexes 37% above the estimate (the total 11% above): the estimate doesn't err high on Atlas; the 70% guard covers it with wide margin |
| Cleanup | `meldiq_api` may not `dropDatabase` (Atlas `readWrite`): the 160 rehearsal collections were dropped one by one. Left on the cluster: database `meldiq` with `orbit_meta` (`schema` only), 0.035 MiB. No authority recorded: **nothing migrated** |
| Fix | `mongo-dryrun` now empties its database collection by collection (works with `readWrite`); new test; committed, **not deployed** (0.51.0 needs `--keep` plus manual drops, as done here) |

Getting the password onto the VPS took several rounds: the Claude app's built-in browser keeps its own clipboard, so
Atlas's Copy didn't reach the Mac and Cmd+V didn't reach Atlas, and a pre-filled password field took a paste as an
addition. `deploy/scripts/set-mongodb-uri.sh` now generates the password itself, stores it on the VPS, puts it on the
clipboard for one paste into Atlas (in Chrome: Cmd+A, Cmd+V, check with SHOW), and clears the clipboard afterwards. Two
passwords were exposed in chat along the way (`footwearfusionstore_db_user`'s, and an intermediate `meldiq_api` one that
was replaced); the current `meldiq_api` password has not been shown to anyone.

## 6. Runbook: Atlas Free setup and migration (owner)

Steps 2–5 are in the Atlas UI and don't touch any other project. Stop at any billing prompt.

1. **Project**: `Meldiq` already exists (`6ae161ca048ef3c4ee51a477`). Add no members or integrations.
2. **Cluster**: in `Meldiq` → *Create* → **Free (M0)**, name `Meldiq-Free`, provider AWS, region **ap-southeast-5
   (Malaysia)** if offered for M0 (2 ms from the VPS), otherwise **ap-southeast-1 (Singapore)** (8 ms; same region as the
   media bucket). Every account request makes one or two round trips. Untick *Preload sample dataset*. Leave
   *Termination protection* off and add no backup or other options (M0 offers none that are paid; if a price appears,
   stop).
3. **Network access**: `72.60.107.88/32` (the VPS), comment `meldiq-api`. For a laptop rehearsal, add your current IP
   as a **temporary** entry (Atlas offers 6 h / 1 day / 1 week). Never `0.0.0.0/0`.
4. **Database user**: *Database Access* → *Add new database user* → password, name `meldiq_api`, *Autogenerate secure
   password* (copy it once). *Database User Privileges* → *Specific privileges*: `readWrite` @ `meldiq` and `readWrite` @
   `meldiq_rehearsal`. **Not** *Atlas admin* or *readWriteAnyDatabase* (the UI's defaults). Restrict to cluster
   `Meldiq-Free`.
5. **Connection string**: *Connect* → *Drivers* → copy the `mongodb+srv://` URI, insert the password, append the
   database: `…mongodb.net/meldiq?retryWrites=true&w=majority`.
6. **On the VPS** (API 0.51.0 is live since 2026-10-28 03:34 UTC): run `deploy/scripts/set-mongodb-uri.sh` on your Mac.
   It asks for `meldiq_api`'s password at a hidden prompt and writes `MONGODB_URI`, `MONGODB_DB=meldiq` and
   `MONGODB_STORAGE_LIMIT_MB=512` to **`/opt/griip-internal-messaging/.env.mongodb`** (mode 600), not to `.env`. With
   `MONGODB_URI` in `.env`, every API restart would connect to Atlas first and refuse to start if it can't (a Free cluster
   can pause when idle), and `/healthz` would answer 503 whenever Atlas drops, before any domain lives there. Until a
   cutover, only one-off containers read it. They run on a **copy** of a fresh backup, never on `/data`:
   ```
   docker run --rm --env-file .env --env-file .env.mongodb -e DATA_DIR=/data -v <backup copy>:/data \
     griip-internal-messaging-api:0.51.0 node dist/admin.js <command>
   ```
   - `mongo-status` → connection, transactions true, round-trip time from the VPS.
   - `mongo-estimate --limit-mb 512` → **if it says DOES NOT FIT, stop.**
   - `mongo-dryrun --db meldiq_rehearsal` → copies all 159 tables into Atlas twice, verifies both runs, drops the copy.
   Encrypted off-VPS copy of the backup before any cutover (`MONGODB.md` §7).
7. **Cutover, one domain at a time** (`MONGODB.md` §6), only with your go-ahead: move the three lines from `.env.mongodb`
   into `.env`, stop the API, `mongo-migrate <domain> --yes`, add the domain to `MONGODB_DOMAINS`, start, smoke-test (`MONGODB.md` §8). Suggested order: preferences,
   reports, relationships, history, accounts; relay and files last, after a send/acknowledge load test against the
   cluster (they are the message hot path, and M0 throttles past 10 GB in or out per 7 days).
8. **Rollback** (any time): stop the API, `mongo-rollback <domain> --yes`, remove it from `MONGODB_DOMAINS`, start.
   SQLite keeps its copy untouched until you approve decommissioning.

**Free tier in production, the trade-off:** no Atlas backups (schedule an encrypted `mongodump --gzip` off the VPS),
500 connections, 10 GB in/out per 7 days, 0.5 GB including indexes, and an idle cluster may be paused. Fine for a
rehearsal and for the small domains; for relay and files at real traffic it is the risk to watch. Any paid tier is
your decision, not taken here.

## 7. Environment variables (names only)

`MONGODB_URI` (secret), `MONGODB_DB` (`meldiq`), `MONGODB_DOMAINS` (empty until a cutover), `MONGODB_STORAGE_LIMIT_MB`
(`512` on M0), `MONGODB_MAX_POOL` (default 20), `MONGODB_TIMEOUT_MS` (default 5000). With `APP_ENV=production` a remote
URI must use TLS (`mongodb+srv://` does). `/healthz` reports `mongodb: true|false|null`.

## 8. Final status

| Step | Status |
|---|---|
| Atlas project `Meldiq` | **Exists** (created by you 2026-10-28 02:45; verified by listing) |
| Cluster (M0) | **Exists, verified**: `Cluster0` (named so instead of `Meldiq-Free`), FREE tier, AWS `AP_SOUTHEAST_1`, MongoDB 8.0.34, not paused |
| Database user | **`meldiq_api`, verified**: `readWrite@meldiq`, `readWrite@meldiq_rehearsal`, scoped to `Cluster0`. Also present: `footwearfusionstore_db_user` (`atlasAdmin`, from Atlas onboarding; its password was pasted in chat: rotate it, never use it for Meldiq) |
| Access list | **Verified**: `72.60.107.88/32` "meldiq-api VPS" (added by Claude in the Atlas UI at your request) and `82.117.226.201/32` (this Mac, Atlas auto-setup) |
| API 0.51.0 (capacity tooling) | **Live** since 2026-10-28 03:34 UTC (`docs/DEPLOYMENT.md`); MongoDB still off in the API |
| Connection string on the VPS | **Stored, verified by login**: `/opt/griip-internal-messaging/.env.mongodb` (600, root); `.env` unchanged, so the API doesn't depend on Atlas |
| Atlas rehearsal | **Passed** (§5d): 159 tables copied twice and verified, 28.76 MiB on Atlas, cleaned up |
| Paid resources | None created (nothing was created at all) |
| GriipBuddy | Untouched: "Project 0" never queried; no GriipBuddy container or database touched on the VPS |
| Source identified and measured (read-only) | **Yes**: `/data/griip.sqlite`, schema 061, 31,703 rows to copy, integrity ok |
| Capacity reviewed | **Yes**: 25.84 MiB estimated, 20.3 MiB measured after a copy, about 4–5% of 512 MiB |
| Data migrated to Atlas | **No** (by design: cutover needs your go-ahead) |
| Full migration rehearsal on a production snapshot (local) | **Yes, verified** (§5b) |
| Backend on MongoDB | Seven domains migrated and exercised on real data; six domains still SQLite-only (§3) |
| Production cutover | **Not done, not enabled**: production unchanged, `MONGODB_*` unset on the VPS |
| Local copies of production data | Deleted after the rehearsal (§5b): snapshot, working copies, local replica set |
| Code | Uncommitted in `meldiq_android/server` (`internal-beta` checkout). The temporary smoke test and the test-only web worktree (`f78407e`) were removed. |
