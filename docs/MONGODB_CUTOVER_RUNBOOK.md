# Moving the rest of production to MongoDB (runbook, 2026-10-28)

The owner's direction (2026-10-28): everything in MongoDB, nothing left in SQLite, and SQLite deleted about 48 hours
later. This runbook moves the domains still in SQLite to MongoDB Atlas. It changes nothing by itself: **every step that
touches production waits for the owner's go-ahead in that conversation**, and **no SQLite file or backup is deleted**
until the owner has confirmed in production that everything works (§8).

Background: `docs/MONGODB.md` (domains, authority, rows, migration tools). Earlier cutovers: `docs/DEPLOYMENT.md`
(2026-10-28 05:20 UTC, seven domains; 11:28 UTC, billing).

## 0. Where things stand

| | Domains |
|---|---|
| In MongoDB (production, API 0.54.0) | `preferences, reports, relationships, history, accounts, files, relay, billing` |
| Still in SQLite | `platform, federation, calls, workspace, conversations, safety, ephemeral, identity` |
| Retired (ignored) | `integrations` |

`safety` (passkeys, two-step sign-in, email changes, staff warnings, bug reports) and `ephemeral` (v1 sessions, sign-in
challenges, pairing, console sessions and ceremonies, federation nonces, minute telemetry samples, Discord sign-in
states) are new domains in this release. MongoDB already holds copies of the `safety` tables from the 05:20 accounts
migration; they are stale (those tables kept being written to SQLite), and `mongo-migrate safety --prune` replaces them.

## 1. Order: why identity goes last

SQLite enforces foreign keys, so **a table whose home is SQLite can't reference a table whose home is MongoDB**. The
server checks this at start (`checkReferences`, `src/infrastructure/database/mongo/index.ts`) and refuses a
`MONGODB_DOMAINS` that breaks it. From the checked-in schema, the references between domains are:

| From | To |
|---|---|
| accounts, calls, conversations, ephemeral, files, history, preferences, safety, workspace | identity |
| calls, files | conversations |
| conversations | workspace |
| workspace (meetings, retired documents) | conversations |

So: `platform` and `federation` reference nobody and can move any time; `calls` before `workspace + conversations`
(which also need `files`, already in MongoDB); `identity` last, with or after everything that references it.

| Stage | Moves | `MONGODB_DOMAINS` afterwards |
|---|---|---|
| 0 (now) | | `preferences,reports,relationships,history,accounts,files,relay,billing` |
| 1 | platform, federation | … `,platform,federation` |
| 2 | calls | … `,calls` |
| 3 | workspace, conversations | … `,workspace,conversations` |
| 4 | safety, ephemeral, identity | … `,safety,ephemeral,identity` (everything) |

The stages can run in one maintenance window (recommended: one write freeze, about 5 minutes for this data size) or in
several; each stage on its own is a valid production state. The full list at the end:

```
MONGODB_DOMAINS=preferences,reports,relationships,history,accounts,files,relay,billing,platform,federation,calls,workspace,conversations,safety,ephemeral,identity
```

## 2. Before the window

1. **Owner's go-ahead** for the deploy and the window, in that conversation.
2. The release built from this branch: full suite on SQLite and with every domain in MongoDB
   (`MELDIQ_TEST_MONGO_DOMAINS=<the full list>`, `--maxWorkers=3`), and `test/schema.test.ts` (the checked-in schema is
   what the migrations create).
3. On the VPS (`/opt/griip-internal-messaging`), sources synced and checked for parity as usual, then
   `docker build --network host -t griip-internal-messaging-api:<new> server` (the build network can't reach the Node
   headers otherwise), and `docker image tag griip-internal-messaging-api:0.54.0 griip-internal-messaging-api:0.54.0-rollback`.

## 3. Backups (all of them before anything moves)

1. SQLite: `bash scripts/backup.sh backups/pre-sqlite-retirement-<UTC>`; copy `.env` and `compose.yaml` into the same
   folder; `docker compose -p griip-internal-messaging -f compose.yaml exec -T api node dist/admin.js verify-backup <file>`
   (integrity, schema version, user count).
2. Off the VPS, encrypted: `bash scripts/offsite-backup.sh` with the same snapshot, then `scripts/offsite-restore-check.sh`.
3. MongoDB: Atlas M0 has no cloud backups. `mongodump --uri "$MONGODB_URI" --db meldiq --gzip --archive` piped straight
   into the encrypted off-site copy (the URI is read from `.env` inside the command, never echoed).
4. Record the counts: `admin table-counts` (SQLite) and `admin mongo-status` (both sides), saved with the backup.

## 4. Rehearsals (nothing in production changes)

1. **Offline, on a copy** (`--network none`): copy the snapshot to a scratch folder owned by the image's user, run the
   new image against it in a throwaway container with no network and the `MONGODB_*`, FCM and Stripe lines left out of
   its environment:

   ```bash
   docker run --rm --network none --env-file .env.rehearsal -e DATA_DIR=/data -v "$PWD/rehearsal:/data" \
     griip-internal-messaging-api:<new> node dist/admin.js stats
   ```

   then start it the same way with `node dist/index.js` and check `/healthz` from inside the container
   (`wget -qO- localhost:8080/healthz`), the schema version, `verify-backup` on the copy, and that the logs have no
   errors. This proves the new image runs on SQLite: the rollback position (§7). Remove the container and the copy.
2. **Capacity**: `admin mongo-estimate --snapshot <file> --limit-mb 512`. The whole database came to 25.65 MiB on
   2026-10-28 (of 512): it fits, with room for the rehearsal copy below.
3. **The copy itself, into a throwaway database**: `admin mongo-dryrun --snapshot <file> --db meldiq_rehearsal` copies
   every table to MongoDB, verifies counts, id sets, row hashes and checksums, and drops the database afterwards (no
   `--keep`). It needs the network to Atlas only, and never touches the `meldiq` database. Collections: about 170 per
   copy, so the live database plus the rehearsal stays under M0's 500.

## 5. The window (write freeze)

```bash
cd /opt/griip-internal-messaging
C="docker compose -p griip-internal-messaging -f compose.yaml"
$C stop api                                   # write freeze starts: phones keep messages in their outboxes
for d in platform federation calls workspace conversations safety ephemeral identity; do
  $C run --rm --no-deps -T api node dist/admin.js mongo-migrate "$d" --yes --prune || break
done
$C run --rm --no-deps -T api node dist/admin.js mongo-verify --all
```

- Run with the **new** image (`compose.yaml` `image:` already names it) and `MONGODB_STORAGE_LIMIT_MB=512` in `.env`:
  `mongo-migrate` refuses before copying when the projection passes 70% of the limit.
- Each `mongo-migrate` snapshots SQLite first (`/data/backups/pre-mongo-<domain>-*`), copies in primary-key order with
  checkpoints, verifies, and only then records MongoDB as the domain's home. A failure stops the loop: fix the cause and
  run it again (re-running is safe), or roll back (§7). `workspace` and `conversations` are checked together by the
  server, so migrate both before starting it.
- Then set `MONGODB_DOMAINS` in `.env` to the full list (§1; or the list of the stage you stopped at), keep a copy of the
  previous `.env` as `.env.before-sqlite-retirement-<UTC>`, `$C config -q`, and start:
  `$C up -d --no-deps --no-build --force-recreate api`. The write freeze ends when `/healthz` answers.
- `scripts/validate-env.sh` still reports "MONGODB_DOMAINS needs MONGODB_URI": a false positive since the 05:20 cutover
  (the URI's `&` breaks `. .env` in bash; Docker reads the file literally).

## 6. Checks after the switch

1. `/healthz` on both hosts: the new version, `mongodb: true`; `verify.sh`: 0 restarts; the logs: no errors.
2. `admin mongo-status`: every domain's authority `mongodb`; `admin stats` and `admin users` read MongoDB now.
3. With the production test identity and a test account: password sign-in and two-step sign-in, a passkey sign-in,
   token refresh, the device list, sending a DM and a channel message, a file upload and download, a call ring,
   a reminder, the console sign-in (password + passkey) and its people, devices and audit pages.
4. **The operator CLI against the running server**: `admin reg-invite 1 1 "cutover check"` then sign up with it, and
   `admin disable <a test account>` then confirm its session is refused within a second or two, then `admin enable`.
   The CLI is a second process: its writes reach the API's memory through the change stream (`docs/MONGODB.md` §4a).
5. Telemetry: the console's analytics overview shows the last minute's samples a few minutes later.

## 7. Rollback (any time, writes made in MongoDB since come back)

Domains come back to SQLite in the reverse dependency order (a SQLite table may not reference MongoDB): **identity
first**, then safety, ephemeral, conversations with workspace, calls, federation, platform.

```bash
$C stop api
for d in identity safety ephemeral conversations workspace calls federation platform; do
  $C run --rm --no-deps -T api node dist/admin.js mongo-rollback "$d" --yes || break
done
```

Each `mongo-rollback` backs SQLite up, replaces the domain's tables with MongoDB's documents in one SQLite transaction,
checks foreign keys (a dangling reference aborts it and changes nothing), verifies, and marks SQLite as the home again.
Then restore `MONGODB_DOMAINS` from `.env.before-sqlite-retirement-<UTC>` and start the API (the new image runs on
SQLite too; `0.54.0-rollback` only once every rolled-back domain is back in SQLite, since it can't read the new
domains from MongoDB). A full data restore from the §3 snapshot is `scripts/restore.sh` (it loses writes made since).

## 8. After: observation, then retiring SQLite (owner only)

- The SQLite file, `backups/pre-sqlite-retirement-*`, the `/data/backups/pre-mongo-*` snapshots and the off-site copies
  stay untouched during the observation period. **Nothing is deleted until the owner confirms in production that
  everything works.**
- With every domain in MongoDB, the server only keeps SQLite for its migration bookkeeping (`schema_migrations`) and
  the retired tables: it reads no domain data from it, and it starts on an empty SQLite file too (it creates one and
  applies the migrations; every domain's authority is already `mongodb`).
- Retiring it, once the owner says so: a last `backup.sh` and off-site copy kept per the retention the owner chooses,
  then the owner removes the SQLite file. A later release can stop opening SQLite at all.
- After retirement there is no SQLite rollback: recovery is the `mongodump` archives (schedule them daily, encrypted,
  off the VPS: Atlas M0 has no backups) or moving to an Atlas tier with backups.
