# Deployment

## Current deployment (internal beta)

| Item | Value |
|---|---|
| VPS | Hostinger VM 1245833, `srv1245833.hstgr.cloud`, **72.60.107.88** (Ubuntu 24.04, 2 vCPU, 8 GB) |
| Compose project | **`griip-internal-messaging`** |
| Directory | **`/opt/griip-internal-messaging`** (root, 0750; `.env` 0600) |
| Services | `api` (`griip-internal-messaging-api:0.41.0` since 2026-10-24 19:30 UTC, built on the VPS; `0.40.0-rollback`, `0.39.0-rollback` and older `-rollback` tags kept), `livekit` (`livekit/livekit-server:v1.13.10`), `ntfy` (`binwiederhier/ntfy:v2.31.1`) |
| Volume / network | `griip-internal-messaging_api-data`, `griip-internal-messaging_default` |
| Public URLs | **`https://msg.meldiq.app`** (API + WebSocket) and **`wss://rtc.meldiq.app`** (LiveKit signalling) since 2026-10-22; the former `msg.griipbuddy.cloud` and `rtc.griipbuddy.cloud` still serve the same backends for apps installed earlier |
| TLS | host nginx: `meldiq-msg.conf` (certificate `meldiq-msg`, msg and rtc.meldiq.app) and `griip-message.conf` (certificate `griip-message`, the former names); both renew automatically (certbot, webroot `/var/www/griip-message-acme`). `meldiq-admin.conf` (certificate `admin.meldiq.app`, certbot `--nginx`, renews automatically) since 2026-10-23 |
| Ports | 127.0.0.1:18080 → api, 127.0.0.1:17880 → LiveKit HTTP. Public: **7881/tcp** (ICE TCP), **7882/udp** (media) |
| Firewall | Hostinger group "web-only" (id 376928): 22, 80, 443 plus 7881/tcp and 7882/udp, which were added for this project |
| DNS | Hostinger DNS for `meldiq.app`: A records `msg`, `rtc`, `web` and `admin` (since 2026-10-23) → 72.60.107.88. Hostinger DNS for `griipbuddy.cloud`: A records `msg` and `rtc` → 72.60.107.88 (former names) |

Nothing else on the server was modified. No other Compose project, volume, nginx site or certificate was touched.

## Operating it (always project-scoped)

```bash
ssh root@72.60.107.88
```

```bash
cd /opt/griip-internal-messaging
```

Status, health and logs:

```bash
docker compose -p griip-internal-messaging -f compose.yaml ps
```

```bash
bash scripts/verify.sh
```

```bash
docker compose -p griip-internal-messaging -f compose.yaml logs --tail 100 api
```

Operator CLI (there is no admin HTTP surface):

```bash
docker compose -p griip-internal-messaging -f compose.yaml exec api node dist/admin.js stats
```

```bash
docker compose -p griip-internal-messaging -f compose.yaml exec api node dist/admin.js invite griipbuddy MEMBER 20
```

**Registration is invite-only by default** (`REGISTRATION_MODE=invite`, T1.6). A new account needs one of:
- an **org invite** code from an org manager, which also joins the person to that org;
- a **registration invite** from the operator. The code is shown once, and only its hash is stored. Existing accounts sign in as before.

```bash
docker compose -p griip-internal-messaging -f compose.yaml exec api node dist/admin.js reg-invite 5 7 "QA testers"
```

That gives 5 uses for 7 days. List invites with `reg-invites` and revoke one with `reg-invite-revoke <hint|id>`.

**Limits on the shared VPS** (T1.6):
- Compose caps the API at 1 CPU, 512 MB and 256 processes, and LiveKit at 1.5 CPU, 1 GB and 512 processes.
- Uploads stream to disk.
- Per-user (250 MiB/day, 1 GiB stored) and server-wide (5 GiB) attachment quotas and in-flight limits are set by the
  `ATTACHMENT_*` variables (`.env.example`).
- Docker local volumes have no disk quota. The storage bound comes from the server-wide attachment cap plus the 7-day expiry, and from
  capped container logs (10 MB × 5 each). `verify.sh` warns when the Docker disk has less than 5 GB free.

Restart this project only:

```bash
docker compose -p griip-internal-messaging -f compose.yaml restart
```

**Never** run `docker system prune`, `docker volume prune` or any other global cleanup on this shared server.

## API-only upgrade (how 0.6.0 went out, 2026-10-19)

The usual way to ship a new API version without touching LiveKit or ntfy:

1. `bash scripts/backup.sh backups/pre-<version>-<UTC time>` on the VPS, plus copies of `.env` and `compose.yaml` into
   the same folder, and `docker image tag griip-internal-messaging-api:<old> griip-internal-messaging-api:<old>-rollback`.
   (Run commands that use `docker compose exec` with stdin closed: piped into `bash -s`, they swallow the rest of the script.)
2. rsync `server/` (without `node_modules`, `dist`, `data`, `test`), `deploy/scripts/` and `.env.example`; then
   `docker build -t griip-internal-messaging-api:<new> server`.
3. Rehearse the migrations on a copy of the snapshot in a throwaway container (`--network none`, `DATA_DIR` pointing at
   the copy, `node dist/admin.js stats`, then `verify-backup`).
4. Install `compose.yaml` (its `image:` names the new tag), `validate-env.sh`, `docker compose … config -q`, then
   `docker compose -p griip-internal-messaging -f compose.yaml up -d --no-deps --no-build api`.
5. `verify.sh`, `/healthz`, server-info features, logs, and a bot round-trip (`tools/griip-bot`, a production test identity).

Rollback: set `image:` back to the `-rollback` tag and run the same `up -d --no-deps --no-build api`. Migrations are
additive, so the older code starts on the newer database (it ignores tables it doesn't know). A full data restore uses
`scripts/restore.sh` with the pre-upgrade archive.

### API 0.8.1 (2026-10-20, 13:04 UTC, owner's go-ahead)

0.8.0 (internal-beta `64a5254`, the server the Android 0.2.3-beta build uses; deployed ~11:45 UTC by another session)
+ `170b988`: integration sign-ins can return to Meldiq Web (`INTEGRATIONS_WEB_RETURN_URLS`, docs/INTEGRATIONS.md §3).
Branch `api-0.8.1-web-return`. No migrations (schema stays 28).

| Step | Result |
|---|---|
| Checks before | `tsc`, build, server tests 723 passed in SQLite and in MongoDB mode (MongoDB mode with 3 workers: at full parallelism its suites time out starting replica sets) |
| Pre-flight | running image 0.8.0; every VPS `server/` file's checksum equal to `64a5254`; `compose.yaml` unchanged; 54 GB free |
| Backup | `backups/pre-0.8.1-20261020T130126Z`: integrity ok, schema 28, 32 users, `.env` + `compose.yaml` copies; image tagged `0.8.0-rollback`; sources kept as `server.pre-0.8.1` |
| Config | `.env` += `INTEGRATIONS_WEB_RETURN_URLS=https://web.meldiq.app/#/workspace/apps` (unquoted: the `#` follows a `/`); a one-off container from the new image parsed it from the real env file before the switch |
| Switch | `validate-env.sh`, `config -q`, `up -d --no-deps --no-build api`; healthy; LiveKit and ntfy not restarted |
| Checks after | `verify.sh` 0 restarts; `/healthz` 0.8.1 on msg.griipbuddy.cloud and through web.meldiq.app; the variable inside the container; no warnings or errors in the log |

Not verifiable on production yet: no one can connect an app there (`integrations-status`: no `INTEGRATIONS_TOKEN_KEY`, no
provider credentials, 0 installs). Rollback: `image: griip-internal-messaging-api:0.8.0-rollback`, the same
`up -d --no-deps --no-build api` (the extra variable is ignored by 0.8.0).

### Passkeys for the Play app (2026-10-24, 08:38 UTC, owner's go-ahead; settings only, API 0.35.0 unchanged)

Passkeys failed in the app installed from Google Play: Play signs it with its app signing key
(`C9:98:DB:04:A0:B3:03:E1:71:D5:B6:E4:07:C8:DB:84:26:24:1E:21:95:B9:69:C6:40:99:78:78:DF:0B:8D:46`), which wasn't in
`PASSKEY_ANDROID_APPS`, so Android wouldn't link the app to msg.meldiq.app (docs/PASSKEYS.md).

| Step | Result |
|---|---|
| Backup | `backups/pre-passkey-play-key-20261024T083719Z`: archive verified (integrity ok, schema 50, 39 users), `.env` and `compose.yaml` copies |
| Config | `.env`: `PASSKEY_ANDROID_APPS` += `com.meldiq.android=C9:98:DB:04:…` (no other line changed); `validate-env.sh` 0 errors (the 2 usual warnings); `config -q` ok; the 0.35.0 image parsed the three entries with the network off |
| Switch | `up -d --no-deps --no-build --force-recreate api` (same image): healthy, 0 restarts, no errors in the log |
| Checks after | `/healthz` 0.35.0 on msg.meldiq.app and msg.griipbuddy.cloud; `assetlinks.json` lists `com.meldiq.android` with the debug and Play keys; passkey options answer. Google's Digital Asset Links check still said "not linked" right after (its answer is cached up to an hour) |

Rollback: copy the backup's `.env` back and recreate `api` the same way.

### API 0.43.0 and Meldiq Web 0.5.0-beta-73bbdda (2026-10-27, 00:19 UTC, owner's go-ahead in the brief)

The Meldling round (meldiq-web `docs/MELDIQ_MELDLING_REPORT.md`). API (branch `meldling-api` on `internal-beta` 59c7916):
Discord server import (`docs/DISCORD_IMPORT.md`; **off until the `DISCORD_*` settings exist**), self-only encrypted
controls (`audience: "self"`, channel read state across a person's browsers), features `discord-import` and
`self-controls`. **Migration 056** adds four `discord_*` tables; nothing existing changes. Web (branch `meldling` on
`ai-workforce-web`): Meldling across the app, its typing indicator, the Discover page, Invite people with a link, Import
from Discord.

| Step | Result |
|---|---|
| Checks before | server **1,099 passed** / 11 skipped, `tsc` clean; web `tsc -b`, lint, format, 513 unit tests (contracts from this API), browser tests Chromium + phone width against 0.43.0: 61 passed, 1 known-intermittent `viewports` failure that passed 7 of 7 rerun (report §Verification) |
| Pre-flight | running 0.42.0; VPS `server/` byte-equal to 59c7916; web 9e42f38; 48 GB free |
| Backup | `backups/pre-0.43.0-20261027T000517Z`: integrity ok, schema 55, 43 users, `.env` + `compose.yaml` copies; image tagged `0.42.0-rollback`; sources kept as `server.pre-0.43.0` |
| Build | 19 files synced (exactly this release's) plus `scripts/validate-env.sh`; `docker build -t griip-internal-messaging-api:0.43.0 server` (`build-0.43.0.log`, done) |
| Rehearsal | backup copy, `--network none`, env without FCM lines: healthy, 0.43.0, schema 56 (migration applied), integrity ok, 43 users; removed after |
| Switch | image 0.43.0, `validate-env.sh` 0 errors ("Discord import off"), `config -q`, `up -d --no-deps --no-build api`: healthy, 0 restarts |
| Checks after | `/healthz` 0.43.0 on both hosts; Discord routes answer "Authentication required" signed out; `verify.sh` clean; live schema 56, integrity ok; 0 errors in the log; backup `post-0.43.0-20261027T002049Z` verified |
| Web | release `0.5.0-beta-73bbdda` (sha256 checked) with the live settings; CSP, site and `config.json` byte-identical; `verify.sh` all passed (API 0.43.0 through the site); intro and invitation pages show Meldling without console errors |

Not checked in production: signed-in flows (no production test account), and Discord import (no Discord application).

Rollback: web (`bash /root/meldiq-web-0.5.0-beta-73bbdda/rollback.sh`, back to 9e42f38) first, then the API image
`0.42.0-rollback` with `up -d --no-deps --no-build api`. 0.42.0 runs on schema 56 as it is (only new tables).

### API 0.42.0 and Meldiq Web 0.5.0-beta-9e42f38 (2026-10-26, 22:26 UTC, owner's go-ahead)

The community-first redesign (meldiq-web `docs/MELDIQ_COMMUNITY_FIRST_REPORT.md`). API (branch `community-first-api`, 4
commits on `internal-beta` a95fb82): presence settles before it changes (`src/modules/realtime/presence.ts`: online after a
connection stays 4 s, offline after 10 s without one; push wake-up fetches no longer flash people online), live calls list
who is sharing their screen (`sharing`, from LiveKit's track webhooks), and `POST /v1/orgs/:orgId/members` adds people
directly (only people the adder knows who would accept a DM from them). **No migration.** Web (branch `community-first`
on `ai-workforce-web`): mascot rail, Create/Discover, unread rule, sound and tab badge, reactors, call badges, Add members,
`/join/<code>` invite links, the Meldiq palette.

| Step | Result |
|---|---|
| Checks before | server **1,076 passed** / 11 skipped, `tsc` clean; web `tsc -b`, lint, format, 504 unit tests (contracts from this API), browser tests Chromium + phone width against 0.42.0 (all passing after two test fixes, report §Verification) |
| Pre-flight | running 0.41.0; VPS `server/` byte-equal to a95fb82 outside tests; web 0f42277 |
| Backup | `backups/pre-0.42.0-20261026T221714Z`: integrity ok, schema 55, 43 users, `.env` + `compose.yaml` copies; image tagged `0.41.0-rollback`; sources kept as `server.pre-0.42.0` |
| Build | 15 files synced (exactly this release's); `docker build -t griip-internal-messaging-api:0.42.0 server` (`build-0.42.0.log`, no errors) |
| Rehearsal | snapshot copy, `--network none`, env without FCM lines: healthy, 0.42.0, schema 55 unchanged, 43 users; removed after |
| Switch | `compose.yaml` image 0.42.0, `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api`: healthy, 0 restarts |
| Checks after | `/healthz` 0.42.0 on both hosts; new route answers "Authentication required"; `verify.sh` clean; 0 errors in the log; backup `post-0.42.0-20261026T222757Z` verified (schema 55, 43 users) |
| Web | release `0.5.0-beta-9e42f38` (sha256 checked) with the live settings; nginx files byte-identical; `verify.sh` all passed (API 0.42.0 through the site); sign-in page without console errors |

Not checked in production: signed-in flows (no production test account). Tunable without a release: `PRESENCE_SETTLE_MS`,
`PRESENCE_GRACE_MS` in `.env`.

Rollback: web (`bash /root/meldiq-web-0.5.0-beta-9e42f38/rollback.sh`, back to 0f42277) first, then the API image
`0.41.0-rollback` with `up -d --no-deps --no-build api` (nothing to undo in the database).

### API 0.41.0, Meldiq Web 0.5.0-beta-0f42277 and console 0.6.0 (2026-10-24, 19:30 UTC, owner's go-ahead)

The master prompt's phases 1–3 and 10 (`implementation/PROGRESS.md`; internal-beta `8601242`…`c918fde`): the Agent
Manager no longer reports itself missing; one invocation rule for mentions and commands on server, web and Android
(ADR 0008); Run Full System Check for communities and the platform (also every 6 hours on its own); the work overview;
a monthly AI budget per agent. Migrations **054** (`ai_system_checks`) and **055** (`ai_agent_installs.max_cost_micro_month`,
index `ai_usage(install_id, at)`), both additive. Web: Overview, Health, budgets, mentions anywhere (orbit_web `0f42277`).
Console: AI Control Center › System check (release `0.6.0-20261024T192944Z`).

| Step | Result |
|---|---|
| Checks before | server **1,051 passed** / 11 skipped, `tsc` and build clean (the server has no linter); web `tsc -b`, lint, format, 484 unit tests, all browser tests 52 passed / 1 failed (`accounts.spec.ts:85`, fails the same on the pre-session code `87c71aa`); console `tsc -b`, lint, format, 17 unit, 5 browser tests |
| Pre-flight | running 0.40.0; VPS `server/` byte-equal to `e494949`; web 08ba69d, console 0.5.0; `origin/internal-beta` and `origin/ai-workforce-web` behind local, nothing new on them; web branch level with `origin/main` |
| Backup | `backups/pre-0.41.0-20261024T192706Z`: integrity ok, schema 53, 39 users, `.env` + `compose.yaml` copies; image tagged `0.40.0-rollback`; sources kept as `server.pre-0.41.0` |
| Build | 32 changed files synced (all this release's); `docker build -t griip-internal-messaging-api:0.41.0 server` (`build-0.41.0.log`, exit 0) |
| Rehearsal | snapshot copy, `--network none`, env without FCM lines: migrations 054–055, schema 55, integrity ok, 39 users, 7 orgs; `ai_system_checks`, the budget column and the usage index present; all 15 installs without a budget; removed after |
| Switch | `compose.yaml` image 0.41.0, `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api`: healthy, 0 restarts |
| Checks after | `/healthz` 0.41.0 on both hosts; 0 errors in the log; new routes answer "Authentication required"; `platform-audit-verify` ok; no budget set; the first scheduled platform System Check (19:30:43, 617 ms): 21 healthy, 1 warning (2 old `ai_not_configured` failures from before the routes were set up), all 7 routes verified, storage round-trip on S3, ffmpeg 8.1.2; backup `post-0.41.0-20261024T193330Z` verified (schema 55, 39 users) |
| Web | release `0.5.0-beta-0f42277` (contracts from the committed server tree; secret scan clean) with the previous settings; nginx files byte-identical; `verify.sh` all passed (API 0.41.0 through the site) |
| Console | release `0.6.0-20261024T192944Z` (secret scan clean); `verify.sh` all passed; serves the new build |

Rollback: web (`bash /root/meldiq-web-0.5.0-beta-0f42277/rollback.sh`, back to `08ba69d`) and console
(`bash /root/meldiq-admin-0.6.0-20261024T192944Z/rollback.sh`, back to 0.5.0) first, then the API image `0.40.0-rollback` with
`up -d --no-deps --no-build api` (054 and 055 are additive; 0.40.0 ignores the new table, column and index).

### API 0.40.0 and Meldiq Web 0.5.0-beta-08ba69d (2026-10-24, 17:34 UTC, owner's go-ahead; channel reading left off)

AI Workforce 2.0 phase 5 (`AI_WORKFORCE_2_PLAN.md`; internal-beta `08965b1`, `de97578`): agents that read channels,
opt-in, with each member's choice; direct conversations with an agent; the recipient rule's one exception (a reader's
device accepted, never required). Migration **053** (additive: `users.kind`, the bot identity, reader, choice, context
and decision tables). The platform setting `ai.workforce.channel_reading` stays **off** (no row; default), so no reader
can be switched on and no key list shows one. Web: the notice and choice, the wrap rule, `@`/`/` agent suggestions,
direct conversations, reading settings (orbit_web `08ba69d`). `@hpke/core` moved to runtime dependencies.

| Step | Result |
|---|---|
| Checks before | server **1,008 passed** / 11 skipped (new `ai_channel_readers` 13 with real end-to-end crypto, `ai_creative_workflow` with real ffmpeg), `tsc` and build clean; web `tsc -b`, lint, format, 466 unit tests, 10 agent browser tests against this server |
| Pre-flight | running 0.39.0; VPS `server/` byte-equal to `822ae06`; web branch level with `origin/main`; `.env` unchanged since 2026-10-24 08:37 |
| Backup | `backups/pre-0.40.0-20261024T173150Z`: integrity ok, schema 52, 39 users, `.env` + `compose.yaml` copies; image tagged `0.39.0-rollback`; sources kept as `server.pre-0.40.0` |
| Build | `docker build -t griip-internal-messaging-api:0.40.0 server` on the VPS (`build-0.40.0.log`, exit 0) |
| Rehearsal | snapshot copy, `--network none`, env without FCM lines: migration 053, schema 53, integrity ok, 39 users all `kind = 'person'`, reader tables empty, no `channel_reading` row, `@hpke/core` loads in the image; removed after |
| Switch | `compose.yaml` image 0.40.0, `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api`: healthy, 0 restarts |
| Checks after | `/healthz` 0.40.0 on both hosts; no errors and no `device_mismatch` in the log since the switch; new routes answer "Authentication required" without a session; `platform-audit-verify` ok; channel reading off, 0 readers; backup `post-0.40.0-20261024T173650Z` verified (schema 53, 39 users) |
| Web | release `0.5.0-beta-08ba69d` (contracts from the committed server tree; secret scan clean) with the previous settings; nginx files byte-identical; `verify.sh` all passed (API 0.40.0 through the site); serves the new build; sign-in page without console errors |

Rollback: web first (`bash /root/meldiq-web-0.5.0-beta-08ba69d/rollback.sh`, back to `5f2b28d`), then the API image
`0.39.0-rollback` with `up -d --no-deps --no-build api` (053 is additive; 0.39.0 ignores `users.kind` and the new tables;
with reading off nothing was created in them).

### API 0.39.0 and Meldiq Web 0.5.0-beta-5f2b28d (2026-10-24, 15:40 UTC, owner's go-ahead)

AI Workforce 2.0 phases 1 and 4 (`AI_WORKFORCE_2_PLAN.md`; internal-beta `a463694` 0.38.0, never deployed alone, and
`822ae06` 0.39.0): the shared skill library and discovery, and human tasks with the Agent Manager assigning work to
people and agents. Migration **052** (additive: `ai_tasks`, `ai_task_events`, `ai_task_settings`, `ai_files.task_id`;
the one active Agent Manager install got the `tasks.assign` tool, inert until a community names who may be assigned
work). Web: the Tasks tab (orbit_web `5f2b28d`). Console unchanged (0.5.0).

| Step | Result |
|---|---|
| Checks before | server **993 passed** / 11 skipped (new `ai_skill_library` 5, `ai_tasks` 5), `tsc` and build clean; web `tsc -b`, lint, format, 466 unit tests, 9 agent browser tests against this server |
| Pre-flight | running 0.37.1; VPS `server/` byte-equal to `37642c9`; web branch level with `origin/main` |
| Backup | `backups/pre-0.39.0-20261024T153809Z`: integrity ok, schema 51, 39 users, `.env` + `compose.yaml` copies; image tagged `0.37.1-rollback`; sources kept as `server.pre-0.39.0` |
| Build | `docker build -t griip-internal-messaging-api:0.39.0 server` on the VPS (`build-0.39.0.log`, exit 0) |
| Rehearsal | snapshot copy, `--network none`, env without FCM lines: migration 052 applied, schema 52, integrity ok, 39 users, 15 installs, task tables empty, `ai_files.task_id` present, the active Agent Manager holds `tasks.assign`; removed after |
| Switch | `compose.yaml` image 0.39.0, `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api`: healthy, 0 restarts, no errors |
| Web | release `0.5.0-beta-5f2b28d` (contracts from the committed server tree; secret scan clean) with the previous settings; nginx files byte-identical; `verify.sh` all passed (API 0.39.0 through the site); serves the new build; sign-in page without console errors |
| Checks after | `/healthz` 0.39.0 on both hosts; the new routes answer "Authentication required" without a session; `platform-audit-verify` ok; AI switches unchanged; backup `post-0.39.0-20261024T154248Z` verified (schema 52, 39 users) |

Rollback: web first (`bash /root/meldiq-web-0.5.0-beta-5f2b28d/rollback.sh`, back to `ac31d7d`), then the API image
`0.37.1-rollback` with `up -d --no-deps --no-build api` (052 is additive; 0.37.1 ignores the new tables and column, and
`tasks.assign` in an install's tool list is ignored by a server that doesn't know it, as 0.37.1 filters unknown tool keys;
only a community entitlement naming `tasks.assign`, set after this release, would fail to load on 0.37.1).

### API 0.37.1 and the first routes (2026-10-24, 13:05 UTC, owner's request)

Fix (internal-beta `37642c9`): the vision verification image is a 64×64 red square instead of one pixel, which
gpt-6.1-sol read as "black" (it names the square red; checked in production). Pre-flight: VPS `server/` equal to
`a9633d8`. Backup `pre-0.37.1-20261024T130344Z` (integrity ok, schema 51, 39 users); image tagged `0.37.0-rollback`;
rehearsal on the copy ok; switch healthy, 0 restarts, no errors; `/healthz` 0.37.1 on both hosts. Server 984 tests passed
after fixing a quota test pinned to 12:00 UTC today. Rollback: image `0.37.0-rollback`.

Routes, at the owner's request, through the console's own set-up code (`setupRoute`, audited as `cli` with a reason) and
in the console by the owner: **reasoning, quick replies and image understanding → `gpt-6.1-sol`** (OpenAI "GriipBuddy"),
each verified by a real request; quick replies keeps `gpt-5.4-mini-2026-03-17` as its fallback. `gpt-6.1-sol` can't
serve speech to text (the transcription endpoint answered 404), text to speech, image generation or embeddings: those
four routes need dedicated models and stay unconfigured.

Media routes, at the owner's request (same audited set-up code, 13:50 UTC): speech to text → `whisper-1` (provider
timings), text to speech → `gpt-4o-mini-tts` (MP3), image generation → `gpt-image-2` (PNG), embeddings →
`text-embedding-3-small` (1536 dimensions), each verified by a real request. **All seven routes ready.** API healthy,
0 restarts, no errors, audit chain intact. Embeddings still feed no feature (no vector store; `AI_WORKFORCE.md` §15).

### API 0.37.0 and console 0.5.0 (2026-10-24, 10:05 UTC, owner's go-ahead)

Capability routes (`AI_WORKFORCE.md` §4; internal-beta `a9633d8`). Audit of production first: the OpenAI provider
had a key but **0 approved models**, so all seven routes were empty; the two failed jobs (Agent Manager,
`ai_not_configured`) stopped at routing before any provider request, so 0 model requests and $0 were correct. This
release: one-step **Set up** per route (approve, capability on, real verification, activate only if it passed), output-type
checks with a next step on failure, six route states, verification cleared when a key changes, requests no route can
serve refused up front (`503 ai_not_configured`), failed-job diagnosis, failed-before-model jobs and verification requests
counted apart. No migration. Web unchanged (0.5.0-beta-ac31d7d; its browser tests updated in `734e098`).

| Step | Result |
|---|---|
| Checks before | server **983 passed** / 11 skipped (new `ai_route_setup.test.ts`, 11 tests), `tsc` and build clean; console typecheck, lint, format, 17 unit tests, 5 browser tests; web 8 agent browser tests against this server |
| Pre-flight | running 0.36.0; VPS `server/` byte-equal to `90782e9`; `.env` unchanged since 08:37 UTC |
| Backup | `backups/pre-0.37.0-20261024T100256Z`: integrity ok, schema 51, 39 users, `.env` + `compose.yaml` copies; image tagged `0.36.0-rollback`; sources kept as `server.pre-0.37.0` |
| Build | `docker build -t griip-internal-messaging-api:0.37.0 server`, detached on the VPS (`build-0.37.0.log`, exit 0) |
| Rehearsal | snapshot copy, `--network none`, env without FCM lines: schema 51 both sides, integrity ok, 39 users, AI on; removed after |
| Switch | `compose.yaml` image 0.37.0, `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api`: healthy, 0 restarts, no errors in the log |
| Console | release `0.5.0-20261024T100424Z` (sha256 checked, secret scan clean), `nginx -t` ok; `verify.sh` all passed; serves the new bundle |
| Checks after | `/healthz` 0.37.0 on msg.meldiq.app and msg.griipbuddy.cloud; Meldiq Web `verify.sh` all passed (API 0.37.0 through the site); the set-up route 403 without a session on the console host, 404 on the app host (like every admin route); `platform-audit-verify` ok; backup `post-0.37.0-20261024T100702Z` verified |

Not done by the release: no route was set up with a real model (that needs the operator's console session and their
provider account); routes stay "Not configured" until the owner uses Set up on each.

Rollback: `compose.yaml` image back to `0.36.0-rollback`, `up -d --no-deps --no-build api` (no schema change). Console:
`bash /root/meldiq-admin-0.5.0-20261024T100424Z/rollback.sh`. Web needs nothing.

### API 0.36.0, console 0.4.0 and Meldiq Web 0.5.0-beta-ac31d7d (2026-10-24, 09:30 UTC, owner's go-ahead)

Operational AI agents (`AI_WORKFORCE.md` §5b; internal-beta `dd8c186`): readiness, a real Test request, activity,
autonomy levels (existing agents became **assisted**, as they were reviewed), per-agent limits, and durable triggers
(schedules, webhooks, handoffs) fired by the worker. Console `0.4.0-20261024T092812Z`: the key's model list when
approving a model and one-step "Use for AI agents" (Text on + a real verification). Web: Configure agent in nine steps.
Migration **051** (additive: columns on installs and jobs, table `ai_triggers`).

| Step | Result |
|---|---|
| Checks before | server **972 passed** / 11 skipped, `tsc` and build clean; web 466 unit tests, 8 agent browser tests (full suite earlier today 47 passed, `accounts.spec.ts:42` failing on `main` too); console typecheck, lint, format, 17 unit tests, 5 browser tests |
| Pre-flight | running 0.35.0; VPS `server/` equal to `984f277` apart from the route-contract file added after that deploy. Another session recreated the api container at 08:38 UTC on the same image after adding the Play-app passkey setting to `.env` (its backup `pre-passkey-play-key-20261024T083719Z`); `.env` kept as is |
| Backup | `backups/pre-0.36.0-20261024T092612Z`: integrity ok, schema 50, 39 users, `.env` + `compose.yaml` copies; image tagged `0.35.0-rollback`; sources kept as `server.pre-0.36.0` |
| Build | `docker build -t griip-internal-messaging-api:0.36.0 server`, detached on the VPS (`build-0.36.0.log`, exit 0) |
| Rehearsal | snapshot copy, `--network none`, env without FCM lines: migration 051 applied, schema 51, integrity ok, 39 users, 15 installs → autonomy assisted / review, `ai_triggers` present; removed after |
| Switch | `compose.yaml` image 0.36.0, `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api`: healthy, 0 restarts, no errors in the log |
| Console | release `0.4.0-20261024T092812Z` (sha256 checked), `nginx -t` ok; `verify.sh` 16/16; serves the new bundle; sign-in page without errors |
| Web | release `0.5.0-beta-ac31d7d` with the previous release's settings; nginx files byte-identical; `verify.sh` all passed (API 0.36.0 through the site); serves the new build; sign-in page without console errors |
| Checks after | `/healthz` 0.36.0 on msg.meldiq.app and msg.griipbuddy.cloud; the new routes 401 without a session; a webhook with a wrong secret 404; `platform-audit-verify` ok; backup `post-0.36.0-20261024T093204Z` verified (schema 51, 39 users) |

Rollback: `compose.yaml` image back to `0.35.0-rollback`, `up -d --no-deps --no-build api` (051 is additive; 0.35.0
ignores its columns and table, and triggers simply stop). Console: `bash /root/meldiq-admin-0.4.0-20261024T092812Z/rollback.sh`.
Web: `bash /root/meldiq-web-0.5.0-beta-ac31d7d/rollback.sh` — roll the web back before the API, since this web build
calls 0.36.0 routes.

### API 0.35.0, AI Workforce 1.0 and console 0.3.0 (2026-10-24, 06:22 UTC, owner's go-ahead)

0.34.0 **plus** AI Workforce 1.0 (`AI_WORKFORCE.md`): the shared model gateway, the agent runtime and its 21 agents,
channel requests, and sharing a channel's recent messages with a request. The console's AI Control Center ships as
console release `0.3.0-20261024T061918Z`. Migrations **049** and **050** are additive. The image now installs `ffmpeg`
and `font-dejavu` for the media engine. **AI Workforce is off** (`ai.workforce.enabled` false): nothing changes for
communities until an operator switches it on in the console. No provider has been verified with a real key yet.
Meldiq Web followed at 06:54 UTC as release **0.5.0-beta-e41839b**: the agents UI ported onto `origin/main` (the first
build was on a checkout 58 commits behind production web), branch `ai-workforce-web` in orbit_web, not yet merged.
Rollback `bash /root/meldiq-web-0.5.0-beta-e41839b/rollback.sh`; record in orbit_web `docs/MELDIQ_WEB_STATUS.md`.
After the deploy, the workforce routes were also registered in the route contracts (`aiWorkforceRoutes.ts`, docs and
fixtures only, no runtime change), so the web's contract test decodes their real answers.

| Step | Result |
|---|---|
| Checks before | `tsc` clean, build ok; server **955 passed** / 11 skipped (SQLite; MongoDB mode not run, since production has no MongoDB). Console: typecheck, lint, format, 17 unit tests, 5 browser tests on the production build under the production CSP |
| Pre-flight | running 0.34.0; VPS `server/` compared file by file with this checkout: every line present only on the VPS was the 0.34.0 form of a line AI Workforce changes, so no other session's work was missing. Console: only this session's files changed since release 0.2.0 |
| Backup | `backups/pre-0.35.0-20261024T061828Z`: integrity ok, schema 48, 39 users, `.env` + `compose.yaml` copies; image tagged `0.34.0-rollback`; sources kept as `server.pre-0.35.0` |
| Build | `docker build -t griip-internal-messaging-api:0.35.0 server` (`build-0.35.0.log`); ffmpeg 8.1.2 and ffprobe in the image |
| Rehearsal | copy of the snapshot, `--network none`, the env without its FCM lines (the FCM file isn't mounted there): migrations 049 and 050 applied, schema 50, integrity ok, 39 users, all `ai_*` tables present, `ai-workforce-status` shows the workforce off; removed after |
| Config | no `.env` change; `compose.yaml` image 0.35.0; `validate-env.sh` 0 errors (the 2 usual warnings); `config -q` ok |
| Switch | `up -d --no-deps --no-build api`: healthy within seconds, 0 restarts, no errors or warnings in the log; LiveKit and ntfy not restarted |
| Console | release `0.3.0-20261024T061918Z` (sha256 checked) by `install-release.sh`; `nginx -t` ok (the two existing warnings) |
| Checks after | `/healthz` 0.35.0 on msg.meldiq.app and msg.griipbuddy.cloud; server-info 61 features incl. `ai-workforce`; `POST /v1/orgs/:id/ai/jobs` 401 without a session; `verify.sh` 0 restarts, 42 GB free; `platform-audit-verify` ok; console `verify.sh` 16/16 and the live sign-in page without errors (only the signed-out session check's 401); backup `post-0.35.0-20261024T062320Z` verified (schema 50, 39 users) |

Rollback: `compose.yaml` image back to `0.34.0-rollback`, `up -d --no-deps --no-build api` (migrations 049 and 050 are
additive; 0.34.0 ignores their tables). Console: `bash /root/meldiq-admin-0.3.0-20261024T061918Z/rollback.sh`.

### API 0.34.0 and Platform Admin 2.0 (2026-10-23, 21:05 UTC, owner's go-ahead)

0.33.0 ("newest device wins in a call", deployed earlier that evening by another session from branch
`call-newest-device-wins`, commit b48436f) **plus** Platform Admin 2.0: telemetry (activity, traffic, presence, resources),
the unified quota engine, AI provider operations, alert rules and the incident lifecycle, devices and sessions, and
console release `0.2.0-20261023T210202Z` (meldiq_central_admin `docs/ADMIN_2_REPORT.md`). b48436f was applied to this
checkout as a patch (clean; `calls/routes.ts` then identical to production), version 0.34.0. Migration **048**
(additive: new tables, nullable columns, one index on `audit_log(actor_id, at)`). New docs: ANALYTICS_DEFINITIONS.md,
RESOURCE_MONITORING.md, QUOTAS.md, AI_OPERATIONS.md, ALERTS.md, PLATFORM_SETTINGS.md, DEVICES_AND_SESSIONS.md.

| Step | Result |
|---|---|
| Checks before | `tsc` clean; server **878 passed** / 10 skipped (SQLite, incl. the merged `call_newest_device` suite); MongoDB mode 873 passed, 1 failed: `ordering.test.ts` (duplicate deliveries under the full parallel run, a flake seen before this release; passes 3/3 alone); the new suites (telemetry, quotas, AI, console insights, calls) pass in MongoDB mode. Console: typecheck, lint, format, 17 unit tests, 4 browser tests on the production build under the production CSP (all 2.0 pages, phone width) |
| Pre-flight | running 0.33.0 (not in this checkout); VPS `server/` compared file by file: its only change beyond 0.32.0 was b48436f |
| Backup | `backups/pre-0.34.0-20261023T210227Z`: integrity ok, schema 47, 39 users, `.env` + `compose.yaml` copies; image tagged `0.33.0-rollback` |
| Build | `docker build -t griip-internal-messaging-api:0.34.0 server` |
| Rehearsal | copy of the snapshot, `--network none`, the image's uid: migration 048 applied, schema 48, integrity ok, 39 users and 14 accounts unchanged, new tables present; removed after |
| Config | `.env` += `PLATFORM_SECRETS_KEY` (generated on the server with `openssl rand -hex 32`, never displayed; in the `.env` backup policy like the other secrets) and `HOST_METRICS_FILE=/host-metrics/metrics.json`; `compose.yaml`: image 0.34.0 and `./host-metrics:/host-metrics:ro`; `validate-env.sh` 0 errors (the 2 warnings are the existing ones: open registration, APP_ENV) |
| Host collector | `scripts/host-metrics.py` + systemd `meldiq-host-metrics.{service,timer}` (every 30 s, sandboxed): host interface, api / livekit / ntfy, 18 other containers summed as "other" |
| Switch | `up -d --no-deps --no-build api`: healthy, 0 restarts, no errors in the log |
| Console | release `0.2.0-20261023T210202Z` (sha256 checked) by `install-release.sh`; `nginx -t` ok (the two existing warnings) |
| Checks after | console `verify.sh` 16/16; `/healthz` 0.34.0 on msg.meldiq.app and msg.griipbuddy.cloud; Meldiq Web loads; the new `/admin/v1` routes answer 401 without a session; telemetry writing (56 series incl. host network and per-service, presence and activity rows); no quota policy and no AI provider (nothing enforced, nothing called); `platform-audit-verify` ok (11 rows); the live sign-in page without console errors; backup `post-0.34.0-20261023T210646Z` verified (schema 48, 39 users) |

Rollback: `compose.yaml` image back to `0.33.0-rollback`, `up -d --no-deps --no-build api` (migration 048 is additive; 0.33.0
ignores its tables). Console: `bash /root/meldiq-admin-0.2.0-20261023T210202Z/rollback.sh`. Collector: `systemctl disable
--now meldiq-host-metrics.timer`. Nothing enforces until a quota policy is written, and AI is off by default.

### API 0.32.0 and the Platform Admin Console (2026-10-23, 17:22 UTC, owner's go-ahead)

0.31.0 (load-test provisioning, migration 047; deployed earlier that day by another session from sources not in this
checkout) **plus** the Platform Admin Console's server side (`src/modules/platformAdmin/`, migration 046,
docs/PLATFORM_ADMIN_CONSOLE.md), and the console itself at **https://admin.meldiq.app** (repository folder
`meldiq_central_admin`, its `docs/DEPLOYMENT_RUNBOOK.md`). 0.31.0's sources were copied from the VPS and its changes
applied to this checkout (`internal-beta`, uncommitted) as a patch; the console's changes went on top; version 0.32.0.

| Step | Result |
|---|---|
| Checks before | merged code: `tsc` clean; server 821 passed / 10 skipped (SQLite); MongoDB mode: the only failure was the table-owner architecture test, which needed 0.31.0's `loadtest_registrations` table registered (fixed, then passing). Console: typecheck, lint, format, 17 unit tests, 4 browser tests on the production build under the production CSP |
| Pre-flight | running 0.31.0, healthy; VPS `server/` identical to the copy merged (rsync checksum dry run); 45 GB free; the upload changed only the console's files and the version |
| Backup | `backups/pre-0.32.0-20261023T171851Z`: integrity ok, schema 47, 39 users, `.env` + `compose.yaml` copies; image tagged `0.31.0-rollback`; sources kept as `server.pre-0.32.0` |
| Build | `docker build -t griip-internal-messaging-api:0.32.0 server` (nohup) |
| Rehearsal | copy of the snapshot, `--network none`, uid 1000: migrations 045, **046**, 047 all applied; 39 users; `verify-backup` ok; the console's tables present and empty; removed after |
| Config | `.env` += `ADMIN_CONSOLE_ORIGIN=https://admin.meldiq.app` (no secrets); parsed by the new image with the data volume read-only before the switch (idle 15 min, max 8 h, step-up 5 min, no network allowlist); `validate-env.sh` 0 errors |
| Switch | `compose.yaml` image 0.32.0, `config -q`, `up -d --no-deps --no-build api`: healthy |
| DNS | Hostinger: A `admin` → 72.60.107.88 added in append mode; every other record of the zone unchanged; resolving on 8.8.8.8 and 1.1.1.1 within a minute |
| TLS | `certbot certonly --nginx -d admin.meldiq.app`: until 2027-01-21, renews automatically |
| Console | release `0.1.0-20261023T164325Z` (sha256 checked on the VPS) installed by its `install-release.sh`: `/opt/meldiq-admin/releases/…`, site `meldiq-admin.conf` and snippet `meldiq-admin-headers.conf`; `nginx -t` ok (the two "protocol options redefined" warnings come from `meldiq-web.conf` and `metallicon-server.conf`, as before) |
| Checks after | `verify.sh` ok, restarts 0, no errors in the log; `/healthz` 0.32.0 on msg.meldiq.app, msg.griipbuddy.cloud and through web.meldiq.app; server-info features unchanged (60); console `verify.sh` 16/16 (TLS, redirect, CSP and headers, immutable assets, no source maps, 403 without the console header, 401 without a session, `no-store`, cross-site change refused, `/v1` not reachable on the console's host, `/admin/v1` 404 on msg.meldiq.app); the live sign-in page in a browser without console errors; `platform-audit-verify` ok (0 rows); backup `post-0.32.0-20261023T172527Z` verified (schema 47, 39 users) |

No console admin exists yet: the owner grants their own account with `platform-admin-grant` (meldiq_central_admin
`docs/DEPLOYMENT_RUNBOOK.md` §7). Rollback: console `rollback.sh` or remove `sites-enabled/meldiq-admin.conf`; API
`image: griip-internal-messaging-api:0.31.0-rollback` and the same `up -d` (0.31.0 ignores the console's tables and
`ADMIN_CONSOLE_ORIGIN`).

### API 0.30.0 (2026-10-23, 12:27 UTC, owner's go-ahead)

Passkeys for Meldiq Web as a second relying party (`internal-beta` `624073f`, docs/PASSKEYS.md › Relying parties):
`PASSKEY_WEB_ORIGINS`, `{ rpId? }` on both options routes, `server-info.passkeys`. No migration (schema stays 45).
Clients: Meldiq Web 0.5.0-beta-22bd2e9 (meldiq-web PR #17); Android unchanged (sends no `rpId`).

| Step | Result |
|---|---|
| Checks before | server tests 769 passed (+ contracts regenerated); web unit 434 passed, `e2e/passkeys` (CDP virtual authenticator) in dev and production builds |
| Pre-flight | running 0.29.0, healthy; a dry-run upload changed only the 9 passkey/version files; 47 GB free |
| Backup | `backups/pre-0.30.0-20261023T122352Z`: integrity ok, schema 45, 36 users, `.env` + `compose.yaml` copies; image tagged `0.29.0-rollback`; sources kept as `server.pre-0.30.0` |
| Build | `docker build -t griip-internal-messaging-api:0.30.0 server` (nohup) |
| Rehearsal | snapshot copy in `rehearsal-0.30.0`, `--network none`, uid 1000, FCM off: `stats` ok (36 users), passkey config parsed (`webOrigins` = `https://web.meldiq.app`) |
| Config | `.env` += `PASSKEY_WEB_ORIGINS=https://web.meldiq.app` (otherwise identical to the backup copy) |
| Switch | `compose.yaml` image 0.30.0, `validate-env.sh` 0 errors (the 2 warnings predate it), `config -q`, `up -d --no-deps --no-build api` |
| Checks after | healthy, `verify.sh` 0 restarts, `/healthz` and server-info 0.30.0 with `passkeys.webOrigins` on msg.meldiq.app, msg.griipbuddy.cloud and web.meldiq.app; options give `msg.meldiq.app` without `rpId` and `web.meldiq.app` with it, other RPs `passkey_unavailable`; assetlinks.json unchanged; no errors in the log; a headless Chromium on web.meldiq.app got a valid passkey prompt and the server's `passkey_unknown` for an unregistered passkey; backup `post-0.30.0-20261023T122723Z` |

Rollback: `image: griip-internal-messaging-api:0.29.0-rollback` and the same `up -d`; 0.29.0 ignores
`PASSKEY_WEB_ORIGINS` (web passkeys then stop being offered; passkeys made on the web stay in the table).

### API 0.29.0 (2026-10-23, 09:44 UTC, owner's go-ahead)

Passkeys for signing in (`internal-beta` `3906e62`, docs/PASSKEYS.md): six account routes and
`/.well-known/assetlinks.json`, `@simplewebauthn/server` 14.0.2. Migration 045 (schema 45: `account_passkeys`,
`account_passkey_challenges`). Clients: Android from `a6a5c78` (employee APK `meldiq-test-passkeys-production-debug.apk`).

| Step | Result |
|---|---|
| Checks before | server tests 766 passed (+ contracts regenerated), Android unit tests 701 passed |
| Pre-flight | running 0.28.0, healthy; a dry-run upload changed only the passkey files and the version; 47 GB free |
| Backup | `backups/pre-0.29.0-20261023T093829Z`: integrity ok, schema 44, 36 users, `.env` + `compose.yaml` copies; image tagged `0.28.0-rollback`; sources kept as `server.pre-0.29.0` |
| Build | `docker build -t griip-internal-messaging-api:0.29.0 server` (nohup) |
| Rehearsal | copy of the snapshot in `rehearsal-0.29.0`, `--network none`, uid 1000, push off: `stats` migrated it to 45, `verify-backup` ok (36 users); removed after |
| Config | `.env` += `PASSKEY_RP_ID=msg.meldiq.app`, `PASSKEY_ANDROID_APPS` (`com.meldiq.android` and `com.meldiq.android.test`, debug certificate `B6:02:DC:…:E5:87`); parsed by the new image before the switch. **Add the release certificate before a release build** |
| Switch | `compose.yaml` image 0.29.0, `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api` |
| Checks after | healthy, `verify.sh` 0 restarts, `/healthz` 0.29.0 on msg.meldiq.app and msg.griipbuddy.cloud, assetlinks.json served, passkey options answer, no errors in the log; backup `post-0.29.0-20261023T094520Z` (schema 45) |

Rollback: `image: griip-internal-messaging-api:0.28.0-rollback` and the same `up -d`; 0.28.0 ignores the new tables and
variables.

### API 0.28.0 (2026-10-23, 05:07 UTC, owner's go-ahead)

Profile and settings changes reach every device live (`internal-beta` `c8dcd07`): a new `user.updated` frame for name,
status, photo, privacy and account-name changes (to the person's devices and everyone sharing a conversation with them)
and for who-may-message, blocks and the selected workspace (the person's own devices only). From now on every deploy
gets a new version (the owner, 2026-10-23). No migration (schema 44), no `.env` or `compose.yaml` change apart from
the image tag.

| Step | Result |
|---|---|
| Checks before | `tsc` clean; server 759 passed / 10 skipped (SQLite); MongoDB mode 757 passed, 2 failed under full load (`ordering` timeout, `push_wakeup`, the known pair), both passing on their own; Android 686 passed, lint 0 errors |
| Pre-flight | running 0.27.0, healthy; the VPS's `server/` and `scripts/` byte-equal to `7a17d3a` |
| Backup | `backups/pre-0.28.0-20261023T050143Z` (archive, `.env`, `compose.yaml`, `server-0.27.0`): verified, schema 44, 36 users. Image `0.27.0-rollback` tagged |
| Build | `git archive c8dcd07` synced with `rsync -c --delete` (0 differences after); `docker build -t griip-internal-messaging-api:0.28.0 server` (run with `nohup`: the SSH session drops when a build starts) |
| Rehearsal | 0.28.0 on a copy of the snapshot, `--network none`: `stats` (36 users, 7 orgs, 74 conversations), healthy with 0 restarts, `/healthz` 0.28.0, nothing logged at warning or above, `verify-backup` ok. Copy deleted |
| Switch | `compose.yaml` image 0.28.0, `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api` at 05:07:35; healthy in 6 s; LiveKit and ntfy not restarted |
| Checks after | `/healthz` 0.28.0 on msg.meldiq.app and msg.griipbuddy.cloud; server-info features identical to 0.27.0's; 401 without a session; the site's `/v1` proxy answers; bad WebSocket token closes with 4401; **live check:** test bot `griipbot6f13` changed its status and `griipboteeb7`, which shares a DM with it, received `user.updated` 188 ms later and fetched the new status (then cleared); `verify.sh` OK (restarts 0, 46 GB free); 220 requests, 0 server errors, nothing logged at warning or above; `backups/post-0.28.0-20261023T050843Z` verified |

Rollback: `image: griip-internal-messaging-api:0.27.0-rollback`, then `up -d --no-deps --no-build api` (same schema).
Clients: Android handles `user.updated` from `3d0380e` (employee APK `meldiq-test-live-quiet-production-debug.apk`);
the web's handling was asked of the "Meldiq web parity with Android" session.

### API 0.27.0 (2026-10-22, 17:02 UTC, owner's go-ahead, Architecture 1.0)

The Architecture 1.0 server (`internal-beta` `7a17d3a`, pushed): the modular layout (`app/`, `modules/`, `shared/`,
`infrastructure/`), the contracts (HTTP and realtime schemas, error catalog, OpenAPI and fixtures in `docs/api` and
`shared/contracts`), and the relay and file records behind `RelayStore`/`FileStore` (SQLite here; MongoDB only after a
cutover). No migration (schema 44), no `.env` or `compose.yaml` change apart from the image tag; no MongoDB variables on
the VPS.

| Step | Result |
|---|---|
| Checks before | `tsc` clean; server 755 passed / 10 skipped (SQLite); MongoDB mode 753 passed, 2 failed under full parallel load (`ordering` timed out at 20 s sending 105 messages, `push_wakeup` the known flake), both passing twice on their own; Android 677 passed, contract tests rerun on the 0.27.0 fixtures |
| Pre-flight | running 0.26.0, healthy; the VPS's `server/` and `scripts/` byte-equal to `f1086aa` (no drift); 49 GB free |
| Backup | `backups/pre-0.27.0-20261022T165827Z` (archive, `.env`, `compose.yaml`, the 0.26.0 sources as `server-0.26.0`): verified, schema 44, 36 users. Image `0.26.0-rollback` tagged |
| Build | `git archive 7a17d3a` synced with `rsync -c --delete` (the module move relocated 119 files), then byte-equal (0 differences); `docker build -t griip-internal-messaging-api:0.27.0 server` |
| Rehearsal | 0.27.0 on a copy of the snapshot (`rehearsal-0.27.0`, owned by uid 1000), `--network none`, env without FCM lines: `stats` (36 users, 47 devices, 7 orgs, 74 conversations), a full start healthy with 0 restarts, `/healthz` 0.27.0, no warnings or errors, `verify-backup` ok. Copy deleted |
| Switch | `compose.yaml` image 0.27.0, `validate-env.sh` 0 errors (the 2 usual warnings), `config -q`, `up -d --no-deps --no-build api` at 17:02:49; healthy in 7 s; LiveKit and ntfy not restarted |
| Checks after | `/healthz` 0.27.0 on msg.meldiq.app and msg.griipbuddy.cloud; server-info features identical to 0.26.0's (60); `/v1/conversations` without a session 401 with the error envelope; `nosniff` and `no-referrer` sent; the site's `/v1` proxy answers; a WebSocket with a bad `auth` frame closes with 4401; two production test bots (`griipboteeb7`, `griipbot6f13`) exchanged encrypted DMs, reactions and read receipts; `verify.sh` OK (restarts 0, 47 GB free); 799 requests in the first minutes, 0 server errors, nothing logged at warning or above; `backups/post-0.27.0-20261022T170721Z` verified |

Rollback: `image: griip-internal-messaging-api:0.26.0-rollback`, then `up -d --no-deps --no-build api` (same schema).
The web release (`0.5.0-beta-b327e82`) was not touched; it talks to 0.27.0 through the same contracts.

### API 0.26.0 (2026-10-22, 07:22 UTC, owner's go-ahead, batch B14b)

Only change: a member can't leave one channel of a community (`leave_community`, 403); managers can still remove
someone from a channel, and groups can still be left. No migration (schema 44).

| Step | Result |
|---|---|
| Backup | `backups/pre-0.26.0-20261022T071851Z` (archive, `.env`, `compose.yaml`, the 0.25.0 server sources); verified, schema 44, 36 users. Image `0.25.0-rollback` tagged |
| Build | rsync of `server/`, `deploy/scripts/`, `.env.example`; `docker build -t griip-internal-messaging-api:0.26.0 server` |
| Rehearsal | 0.26.0 on a copy of the snapshot in the project folder, `--network none`, env without FCM lines: `stats` (36 users, 7 orgs, 74 conversations), a full start healthy (`/healthz` 0.26.0) with no warnings, `verify-backup` ok. Copy deleted |
| Switch | `compose.yaml` image 0.26.0, `validate-env.sh` 0 errors (the 2 usual warnings), `config -q`, `up -d --no-deps --no-build api`; healthy, 0 restarts, no warnings or errors in the log |
| Checks after | `/healthz` 0.26.0 on msg.meldiq.app and msg.griipbuddy.cloud; `verify.sh` OK (LiveKit, ntfy, restarts 0, 48 GB free); server-info 0.26.0; the members route refuses requests without a session (401); `nosniff` and `no-referrer` still sent; `backups/post-0.26.0-20261022T072521Z` verified |

Rollback: `image: griip-internal-messaging-api:0.25.0-rollback`, then `up -d --no-deps --no-build api`.

**Web, same day:**
- I installed meldiq-web `main` (`0.5.0-beta-cd449f5`) at 07:24 UTC. The site was then serving `0.5.0-beta-ea703df`,
  another session's release from its branch: screen sharing shown whole, and browser notifications. That release
  isn't in `main`, so `cd449f5` would have taken both away.
- I rolled back at 07:26 UTC (`rollback.sh`). The site serves `0.5.0-beta-ea703df` again, and `verify.sh` passes
  (API 0.26.0 through the site).
- The web side of B14b (no leaving one channel, the online subtitle) is in `main` and goes out with that session's
  next release.
- Until then, the web's "Leave channel" button gets the server's `leave_community` refusal.

### nginx security headers (2026-10-22, 03:16 UTC, batch B15)

`deploy/nginx/meldiq-msg.conf` adds `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` to
msg.meldiq.app and rtc.meldiq.app. The previous file is `/etc/nginx/sites-available/meldiq-msg.conf.pre-b15`. After
`nginx -t` and a reload, `/healthz` answered 0.25.0 with both headers. The API container was not restarted. To revert,
copy the `.pre-b15` file back, then run `nginx -t && systemctl reload nginx`.

### API 0.25.0 and Meldiq Web e9f8d2b (2026-10-22, 02:31 UTC, owner's go-ahead)

Batch B14 (`internal-beta` `22d5303`): voice channels take no messages (`403 voice_channel`; the call's encrypted controls
still pass). No migration (schema 44). Web: no message box in voice channels.

| Step | Result |
|---|---|
| Checks before | server 711 passed / 10 skipped; Android 646 passed, lint 0 errors; web 262 passed |
| Backup | `backups/pre-0.25.0-20261022T020957Z`: integrity ok, schema 44, 33 users; `.env`, `compose.yaml`, `livekit.yaml` copies; image tagged `0.24.0-rollback`; sources kept as `server.pre-0.25.0` |
| Sources | rsync with checksums: `package.json`, `package-lock.json`, `src/app.ts`, `src/routes/messages.ts` |
| Rehearsal | 0.25.0 on a copy of the snapshot (in the project folder), `--network none`: healthy, no warnings; copy deleted |
| Switch | image 0.25.0, `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api`; healthy, 0 restarts, no warnings or errors |
| Checks after | `/healthz` 0.25.0 on msg.meldiq.app and msg.griipbuddy.cloud; `/v1/messages` refuses requests without a session |
| Web | release `0.2.4-beta-e9f8d2b`; `verify.sh` all checks passed |

Rollback: `image: griip-internal-messaging-api:0.24.0-rollback`, then `up -d --no-deps --no-build api`; the web with
`bash /root/meldiq-web-0.2.4-beta-e9f8d2b/rollback.sh`.

### API 0.24.0, msg.meldiq.app and Meldiq Web 6ecfc81 (2026-10-22, 01:14 UTC, owner's go-ahead)

Batches B4–B13 (`internal-beta`, docs/product/MELDIQ_SESSION_HANDOFF.md §0) and the move to the Meldiq names.

| Step | Result |
|---|---|
| Checks before | server 710 passed / 10 skipped on SQLite and with the MongoDB-capable domains; Android 641 passed, lint 0 errors; web 262 passed |
| DNS | `msg.meldiq.app` and `rtc.meldiq.app` A → 72.60.107.88 (added, nothing else in the zone changed) |
| Backup | `backups/pre-0.24.0-20261022T010925Z`: integrity ok, schema 33, 33 users; `.env`, `compose.yaml` and `livekit/livekit.yaml` copies; image tagged `0.13.0-rollback`; sources kept as `server.pre-0.24.0` |
| Sources | rsync with checksums: migrations 034–044 added, changed sources only |
| Rehearsal | 0.24.0 on a copy of the snapshot, `--network none`, env without FCM lines: `stats` (33 users, 6 orgs), `community-migration --verify` no differences, a full start healthy with no warnings, `verify-backup` ok (schema 44). Copy deleted |
| nginx and TLS | new site `meldiq-msg.conf` (in `deploy/nginx/`), certificate `meldiq-msg` for msg and rtc.meldiq.app (Let's Encrypt, until 2027-01-20, renews automatically) |
| Config | `.env`: `PUBLIC_API_URL=https://msg.meldiq.app`, `LIVEKIT_PUBLIC_URL=wss://rtc.meldiq.app`; `validate-env.sh` 0 errors (the 2 usual warnings) |
| Switch | `compose.yaml` image 0.24.0, `config -q`, `up -d --no-deps --no-build api`; healthy; LiveKit and ntfy not restarted |
| Checks after | `/healthz` 0.24.0 on msg.meldiq.app and msg.griipbuddy.cloud; restarts 0; no warnings or errors in the log; every feature flag the Android app checks is listed (except `push-unifiedpush`, off before too: `PUSH_UNIFIEDPUSH_HOSTS` isn't set); new routes refuse requests without a session; `reports.key` created; `backups/post-0.24.0-*` verified (schema 44) and includes `reports.key` |
| Web | release `0.2.4-beta-6ecfc81` (the same code as meldiq-web `dbf67ce` on GitHub: the commit messages were cleaned after the build) installed for web.meldiq.app (CSP `connect-src` adds rtc.meldiq.app); `verify.sh` all checks passed, API through the web origin 0.24.0 |

Rollback: `image: griip-internal-messaging-api:0.13.0-rollback`, then `up -d --no-deps --no-build api`. Migrations 034–044 only
add tables and columns, which 0.13.0 ignores. The `.env` addresses can stay (both names reach the same server). The web
rolls back with `bash /root/meldiq-web-0.2.4-beta-6ecfc81/rollback.sh`.

### API 0.13.0 (2026-10-21, 07:17 UTC, owner's go-ahead)

Discord reference round (`internal-beta` at `72d1b0b`, docs/product/MELDIQ_COMMUNITY_CHAT_SPEC.md): voice channel
permissions (`voice.connect`, `voice.speak`: listen-only LiveKit tokens), forum tags (migration 033), deleting a
community channel. Meldiq Web unchanged.

| Step | Result |
|---|---|
| Checks before | server 615 passed / 10 skipped; Android 558 passed, lint 0 errors, debug build ok; emulator pass (docs/product/MELDIQ_DISCORD_REFERENCE_AUDIT.md §4) |
| Pre-flight | running 0.12.0, healthy; VPS `server/` sources identical to `944ec4b` (checksum); `compose.yaml` as recorded; 52 GB free |
| Backup | `backups/pre-0.13.0-20261021T071526Z`: integrity ok, schema 32, 33 users, `.env` + `compose.yaml` copies; image tagged `0.12.0-rollback`; sources kept as `server.pre-0.13.0` |
| Sources | rsync dry run listed only the release's files; VPS `server/` identical to `72d1b0b` (checksum) |
| Rehearsal | 0.13.0 on a copy of the snapshot, `--network none`, env copy without the FCM lines: migration 33 applied (`conversations.forum_tags`), `community-migration --verify` no differences, a full start healthy with no warnings, `verify-backup` ok (schema 33, 33 users). Copy deleted |
| Switch | `validate-env.sh` 0 errors (the 2 usual warnings), `config -q`, `up -d --no-deps --no-build api`; healthy; LiveKit and ntfy not restarted |
| Checks after | `/healthz` 0.13.0; restarts 0; no warnings or errors in the log; `verify.sh` OK, 50 GB free; `community-migration --verify` no differences; server-info lists `forum-tags`, `channel-delete`, `voice-permissions`; the new and changed routes refuse requests without a session ("Authentication required"); web.meldiq.app answers 200 |

Not checked on production: a voice channel's listen-only join with real participants, and deleting a channel (both
covered by the server tests and, for deleting, the emulator against a local server).

Rollback: `image: griip-internal-messaging-api:0.12.0-rollback`, then `up -d --no-deps --no-build api`. Migration 033
only adds a column, which 0.12.0 ignores; forum tags set under 0.13.0 stay stored for the next upgrade.

### API 0.12.0 (2026-10-21, 05:31 UTC, owner's go-ahead)

Community rebuild (`internal-beta` at `944ec4b`, docs/COMMUNITY_REBUILD_2026-10-21.md): categories, channel permissions,
forum channels, discovery, bans; branches and teams converted to roles and categories; workplace modules and optional
connectors removed (migration 032). Meldiq Web was not updated: its screens for the removed features (inbox, webhooks,
API keys, AI, groups, documents, workflows, branches and teams) no longer work against this API, as the owner accepted.

| Step | Result |
|---|---|
| Checks before | server 604 passed / 10 skipped; Android 537 passed, lint and debug build ok; 1 GiB acceptance 12/12 |
| Pre-flight | running 0.11.0, healthy; VPS `server/` sources identical to `61b63d7` (checksum); `compose.yaml` identical to the repository's; 52 GB free |
| Backup | `backups/pre-0.12.0-20261021T052648Z`: integrity ok, schema 31, 33 users, `.env` + `compose.yaml` copies; image tagged `0.11.0-rollback`; sources kept as `server.pre-0.12.0` |
| Sources | rsync with `--delete` (the 64 removed module files went); VPS `server/` identical to `944ec4b` (checksum) |
| Rehearsal | 0.12.0 on a copy of the snapshot, `--network none` (env copy without the FCM lines: the key file is in the live volume): migration 32 applied; `community-migration --verify` converted 1 team (1 channel into 1 category), no visibility differences; a second run converted nothing; a full start was healthy with no warnings. Copy deleted afterwards |
| Switch | `validate-env.sh` 0 errors (the 2 usual warnings), `config -q`, `up -d --no-deps --no-build api`; healthy; LiveKit and ntfy not restarted |
| Checks after | `/healthz` 0.12.0; restarts 0; no warnings or errors in the log; `verify.sh` OK, 51 GB free; `community-migration --verify` no differences; server-info lists `community-channels`, `community-discovery`, `community-moderation`, `guest-expiry`, `files-1g`, file limit 1 GiB, no `integrations` or `ai`; new routes answer 401 without a session |
| Retired data | `retired-data` report: everything 0 except 1 row in `api_keys`. Not purged |

Not done: phone acceptance of the community app, the retired settings cleanup (`INTEGRATIONS_WEB_RETURN_URLS` is still
in `.env` and ignored) and `retired-data --purge`.

Rollback: `image: griip-internal-messaging-api:0.11.0-rollback`, then `up -d --no-deps --no-build api`. Migration 032
only adds tables and columns and the old branch/team tables are untouched, so 0.11.0 starts on the same database;
categories, overwrites and bans made under 0.12.0 are ignored by it.

### API 0.11.0 and Meldiq Web 7d48f85 (2026-10-21, 02:55 UTC, owner's go-ahead)

Key backup under the password (`internal-beta` at `61b63d7`, docs/KEY_BACKUP.md): a new device needs email, password and
an emailed code; the recovery key is for when the email can't work or the password was reset (migration 031).

| Step | Result |
|---|---|
| Checks before | server 764 passed / 10 skipped in SQLite and MongoDB modes; web 255 unit + 154 integration passed; Android 559 passed, lint ok; CI: server job and web passed |
| Pre-flight | running 0.10.0, healthy; VPS `server/` sources identical to `d6a8d08` (checksum); 52 GB free |
| Backup | `backups/pre-0.11.0-20261021T025230Z`: integrity ok, schema 30, 33 users, `.env` + `compose.yaml` copies; image tagged `0.10.0-rollback`; sources kept as `server.pre-0.11.0` |
| Sources | VPS `server/` identical to `61b63d7` (checksum) |
| Rehearsal | 0.11.0 on a copy of the snapshot, `--network none`: migration 31 applied, `account_key_backups` and `account_key_unlocks` present, `verify-backup` ok (schema 31, 33 users) |
| Switch | `validate-env.sh` 0 errors (the 2 usual warnings), `config -q`, `up -d --no-deps --no-build api`; healthy; LiveKit and ntfy not restarted |
| Checks after | `/healthz` 0.11.0; restarts 0; no warnings or errors in the log; schema 31, 33 users, 0 backups; server-info lists `key-backup`; the new routes answer 401 without a session |
| Web | release `0.2.4-beta-7d48f85` (contains `d870db2`); `verify.sh https://web.meldiq.app` all passed; API 0.11.0 through it |

Not checked on production: an actual unlock email (needs a real account's inbox). The whole flow was checked against a
local server in the browser and by the integration tests.

Rollback:
- API: `image: griip-internal-messaging-api:0.10.0-rollback`, then `up -d --no-deps --no-build api`. 0.10.0 ignores the
  two new tables.
- Web: `bash /root/meldiq-web-0.2.4-beta-7d48f85/rollback.sh`.

### API 0.10.0 and Meldiq Web d870db2 (2026-10-20, 18:09 UTC, owner's go-ahead)

Round 3 (`claude/meldiq-3-reference-rebuild` at `d6a8d08`): statuses with an emoji and an end time, pausing
notifications, "N online" per conversation (migration 030), plus the client work in
docs/product/MELDIQ_3_REFERENCE_MATRIX.md. Deployed before phone acceptance, on the owner's instruction; the owner
plans full testing next.

| Step | Result |
|---|---|
| Checks before | on the final source: server 753 passed / 10 skipped in SQLite and MongoDB modes; web 402 passed; Android 546 passed, lint 0 errors |
| Pre-flight | running 0.9.0, healthy; VPS `server/` sources identical to `5ef1b71` (checksum); 52 GB free |
| Backup | `backups/pre-0.10.0-20261020T180755Z`: integrity ok, schema 29, 33 users, `.env` + `compose.yaml` copies; image tagged `0.9.0-rollback`; sources kept as `server.pre-0.10.0` |
| Rehearsal | 0.10.0 on a copy of the snapshot, `--network none`: migration 30 applied, the three columns present, `verify-backup` ok (schema 30, 33 users) |
| Switch | `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api`; healthy; LiveKit and ntfy not restarted |
| Checks after | `/healthz` 0.10.0; restarts 0; no warnings or errors in the log; schema 30, 33 users; server-info lists `status-expiry`, `notifications-pause`, `conversation-presence` |
| Web | release `0.2.4-beta-d870db2` (contains `4a79225`); `verify.sh https://web.meldiq.app` all passed; API 0.10.0 through it |

Rollback:
- API: `image: griip-internal-messaging-api:0.9.0-rollback`, then `up -d --no-deps --no-build api`. 0.9.0 ignores the
  three new columns.
- Web: `bash /root/meldiq-web-0.2.4-beta-d870db2/rollback.sh`.

### API 0.9.0 and Meldiq Web 4a79225 (2026-10-20, 16:53 UTC, owner's go-ahead)

Branch `claude/meldiq-2-redesign` at `5ef1b71`: production 0.8.1, remediation round 1 (account deletion, migration
013; revoked-device fix) and Meldiq 2.0 round 1 (communities and analytics, migration 029; curated directory;
experiments off). The owner chose to deploy before the phone acceptance test.

| Step | Result |
|---|---|
| Checks before | GitHub CI green on both branches in both repositories (server, Android, web); server 745 tests passed locally |
| Pre-flight | running image 0.8.1, healthy; VPS `server/` sources identical to `api-0.8.1-web-return` (checksum); 53 GB free |
| Backup | `backups/pre-0.9.0-20261020T165059Z`: integrity ok, schema 28, 33 users, `.env` + `compose.yaml` copies; image tagged `0.8.1-rollback`; sources kept as `server.pre-0.9.0` |
| Rehearsal | 0.9.0 image on a copy of the snapshot, `--network none`: migrations 13 and 29 applied, `verify-backup` ok (schema 29, 33 users), 6 workspaces all `team` |
| Switch | `validate-env.sh` 0 errors, `config -q`, `up -d --no-deps --no-build api`; healthy; LiveKit and ntfy not restarted |
| Checks after | `verify.sh` 0 restarts; `/healthz` 0.9.0; server-info lists `account-delete`, `communities`, `experiments`, `analytics-events`; no warnings or errors in the log. `EXPERIMENTS_MODE` and `ANALYTICS_ENABLED` are unset, so both are off |
| Web | release `0.2.4-beta-4a79225` (contains the previous `e95c739`), installed with the same command as before; `verify.sh https://web.meldiq.app` all passed; API 0.9.0 through it; web.griipbuddy.cloud still redirects |

Not done: the bot round-trip (the permission check refused reading the bot's identity file) and phone acceptance.

Rollback:
- API: `image: griip-internal-messaging-api:0.8.1-rollback`, then the same `up -d --no-deps --no-build api`. 0.8.1
  ignores `users.deleted_at`, `orgs.kind` and `analytics_daily`.
- Web: `bash /root/meldiq-web-0.2.4-beta-4a79225/rollback.sh`.

Existing `.env` warnings, unchanged by this deploy: `APP_ENV=development` and `REGISTRATION_MODE=open` on production.

## Redeploying from a workstation

```bash
TARGET=root@72.60.107.88 ./deploy/scripts/deploy.sh
```

The script:
1. runs `scripts/preflight.sh` on the VPS, which is read-only: resources, Compose projects, port conflicts, proxy and firewall;
2. rsyncs `server/`, `compose.yaml`, the LiveKit template and the scripts;
3. runs `gen-config.sh`, which creates `.env` with fresh LiveKit credentials only if it's missing and renders `livekit/livekit.yaml`;
4. runs `docker compose -p griip-internal-messaging up -d --build` followed by `verify.sh`.

## First-time setup on another server

1. Run `deploy/scripts/preflight.sh` on the server and resolve any conflicts it reports.
2. Point DNS for two names at the server: one for the API, one for LiveKit.
3. Open the LiveKit media ports in the provider firewall: TCP `LIVEKIT_RTC_TCP_PORT` (7881) and UDP `LIVEKIT_RTC_UDP_PORT` (7882).
   The host port must equal the container port so that ICE candidates are correct.
4. Copy `deploy/` and `server/` to `/opt/griip-internal-messaging`, then run `scripts/gen-config.sh`. Edit `.env` to set `PUBLIC_API_URL`,
   `LIVEKIT_PUBLIC_URL` and `LIVEKIT_NODE_IP` (the public IPv4), then run `scripts/gen-config.sh` again.
5. Set up a reverse proxy with TLS:
   - API name → `127.0.0.1:18080`, with WebSocket upgrade and a 3600 s read timeout.
   - LiveKit name → `127.0.0.1:17880`, with WebSocket upgrade.
   - See the live config at `/etc/nginx/sites-available/griip-message.conf`.
6. Start the project:

   ```bash
   docker compose -p griip-internal-messaging -f compose.yaml up -d --build
   ```

7. Check health with `bash scripts/verify.sh` and `curl https://<api>/healthz`.

## Seeding the GriipBuddy structure (optional, development data)

Register the owner in the app first, then run:

```bash
docker compose -p griip-internal-messaging -f compose.yaml exec api node dist/seed.js --owner <username> --force
```

It creates the GriipBuddy org with the Bangladesh and International branches, the departments, teams and channels from the spec, and prints invite codes.
It refuses to run with `NODE_ENV=production` unless you pass `--force`, and it never creates sample users or messages.

## MongoDB (2026-10-19, not in production)

The server can keep the accounts and preferences domains in MongoDB (`docs/MONGODB.md`): the settings are in
`deploy/.env.example` (`MONGODB_*`), checked by `validate-env.sh`. Moving a domain is a maintenance-window step with
backups first (`MONGODB.md` §6–§7: stop the API, `node dist/admin.js mongo-migrate <domain> --yes`, add the domain to
`MONGODB_DOMAINS`, start, smoke-test); rollback is `mongo-rollback`. Production has no MongoDB deployment yet.

## Rollback / removal (reversible)

Stop the project and keep its data:

```bash
docker compose -p griip-internal-messaging -f compose.yaml down
```

Full removal deletes this project's data volume only:

```bash
docker compose -p griip-internal-messaging -f compose.yaml down -v
```

Then:
- Run `rm /etc/nginx/sites-enabled/griip-message.conf`, then `nginx -t`, then `systemctl reload nginx`.
- Optionally run `certbot delete --cert-name griip-message`.
- Remove the `msg` and `rtc` DNS records and the 7881/tcp and 7882/udp firewall rules in Hostinger.

## Android app configuration

- Release builds default to production (`https://msg.griipbuddy.cloud` until the Meldiq hostname is approved); debug
  builds to development (`http://localhost:8080`, through `adb reverse`). Set `meldiq.apiBaseUrl.<environment>` in
  `android/local.properties` for another address (docs/ENVIRONMENTS.md).
- Users can change the server before creating an identity: Welcome screen → server icon.

## Resource observations (2026-10-16)

- **Before deployment:** the VPS ran about 20 other containers. RAM was 7.8 GiB total with about 3.6 GiB available and no swap. Disk was 54 GB free. No OOM kills in 7 days.
- **After deployment, idle:** the API uses about 32 MiB of RAM and LiveKit about 22 MiB, both at near-zero CPU. They are capped at 512 MiB and 1 GiB respectively.
- **Media:** a 2-party test call carried E2EE video and audio through the SFU. Group-call capacity hasn't been benchmarked.
- **Warning:** LiveKit says the host's UDP receive buffer (425,984 bytes) is below its recommended 5 MB. That's fine for small tests. Raising `net.core.rmem_max` is a host-wide change, so it was not made.
