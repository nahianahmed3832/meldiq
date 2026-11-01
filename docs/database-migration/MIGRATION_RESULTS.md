# Migration results — 2026-11-01

**Status: implementation and local restored-data rehearsals completed. Production cutover NOT performed.**

## Implementation delivered

Final staged candidate source: `/Users/nahian/.cache/meldiq-database-latest`, branch `codex/unified-atlas-redis-latest`, based on pinned commit `1e99c4ae` / API 0.73.0. The owner explicitly requested **finish staging only while production keeps moving**; no production cutover is part of this handoff. The intermediate 0.72.1 candidate remains at `/Users/nahian/.cache/meldiq-database-current` for its recorded rehearsal evidence. The original implementation/rehearsal remains at `/Volumes/code_files/meldiq_database_migration` on `codex/unified-atlas-redis` (base d7fd6b31 / API 0.71.1); it is superseded for rollout. Existing user changes in web, Android and admin roots were preserved. Review/apply artifact: `deploy/database-migration/atlas-redis.patch` in the web repository, checked against clean pinned base 1e99c4ae.

Implemented centralized Redis configuration/lifecycle, scoped preference cache-aside with generation invalidation, distributed HTTP user/IP limits, expiring device presence/typing, preference Pub/Sub and authenticated admin diagnostics. Added strict Atlas-only startup with verified authority markers and no persistent SQLite API connection, production TLS/certificate enforcement, safe connection diagnostics, bounded schema creation, streamed verification/pruning, paced pre-copy without authority changes, change-only final writes, active-authority overwrite refusal, reviewed conflict archival, AUTOINCREMENT high-water preservation, read-only preflight/relationship/audit validation, encrypted snapshot/restore tools, safe Redis deployment preparation and client-driver boundary scans.

## Executed migration rehearsal

| Check | Actual result |
|---|---|
| Encrypted Atlas restore | 78 collections, 50,107 records; exact BSON types, validators, indexes, counts and per-collection checksums restored and verified |
| SQLite restored snapshot | quick_check = ok; immutable source during migration |
| Remaining source copy | 625,346 records across 174 tables |
| Transformation/rejection | 625,346 transformed and verified; zero rejected; zero duplicate records introduced |
| Copy verification | Every source/destination count, original ID and deterministic row checksum matched |
| Re-run | Every table verified again; checksums/counts unchanged |
| Destination conflicts | 2 original Atlas versions archived locally before reviewed replacement; production versions untouched |
| Declared relationships / tenant checks | No missing declared parent or same-community reference detected |
| Platform audit chain | 183 rows, zero invalid hashes/links |
| Atlas-only API startup | /healthz 200, /v1/server-info 200; all 16 active domains; persistent SQLite file not opened |
| Second memory rehearsal | Same copy/relationships/audit/startup checks passed; GC-enabled retained-state measurement ~297 MiB RSS, ~259 MiB heap |
| Production application writes by this work | None; encrypted backups and isolated build/rehearsal artifacts only; production services/configuration unchanged |

Already-authoritative Atlas domains and native feature collections were restored from Atlas, not overwritten from stale SQLite. Names/IDs/timestamps, E2EE boundaries and S3 metadata/object references were preserved. “Community” is used in new explanatory text; `orgId` and existing API/collection identifiers remain compatible.

The preparation Atlas and SQLite snapshots were taken online separately and are **not a mutually consistent final cross-store snapshot**. A final controlled write freeze and fresh snapshots remain mandatory for cutover. The second probe contains GC and prior rehearsal allocations; it does not certify peak memory or the exact production Node/container workload.

## Automated checks

- All-domain MongoDB application run: **102 passed across 6 files** (accounts authentication, server messages, community channels, preferences, platform admin authentication and billing), using standard isolated thread workers with one worker and longer startup timeouts for hundreds of schemas. No tests were skipped in this successful run. Evidence: `tests-atlas-application.txt`.
- Final Redis/migration/backup/schema run: **23 passed across 4 files**. Includes cross-client rate limits, cache expiry/invalidation races, outage/reconnection, Pub/Sub, presence leases, deployment ACL rejection/authentication, import resumption/idempotency, conflict archival, high-water IDs, TLS rules, tenant validation and BSON restore. Evidence: `tests-migration-infrastructure.txt`.
- Broader Mongo repository/migration tests: **45 passed across 3 files** (migration, Rows and backup) after bounding schema concurrency; includes rollback, validators, unique indexes and change streams.
- TypeScript passed after the final source changes. Updated API contracts generated. Static browser boundaries passed for 586 web and 115 admin source files; no direct database drivers or public database credentials found.
- The initial full/default and broad all-domain runs under concurrent machine load encountered timeouts and were interrupted, not counted as passes. A complete default run subsequently finished with 1,803 passed, 6 failed and 18 skipped. The six failures were resolved: split module-specific audit validation out of infrastructure; register two already existing table owners and replace a cross-module deletion call with the billing service method; migrate three fixtures before opening their target stores; and update the old public monthly Spark catalog expectation to the current Plus catalog while explicitly verifying preserved legacy Spark pricing/provider references. That billing expectation also failed on the unchanged baseline (13 passed, 1 failed); business pricing behavior was not changed. Affected regression run: **50 passed across 7 files**. No tests were disabled. A second full rerun under concurrent Mac load hit startup timeouts in official_bots_games and community_templates and was interrupted; it is **not** counted as a pass. Both affected groups then passed on isolated rerun: **34 passed across 2 files**, with no skips. No source test was disabled. See tests-contention-recheck.txt.
- No physical Android/device UI smoke, live buyer payment, S3 object reconciliation, external worker deployment or production maintenance cutover was performed. Existing Android Room/SQLCipher cache/outbox and authenticated `/v2/messages/import` were retained. User private keys were not moved.

## Backup handling

Encrypted preparation files are under `/Users/nahian/.local/share/meldiq-migration/20261101T135353Z` with directory mode 0700 and files 0600, outside Git. The deployment environment and reports sealing key are separately encrypted; decryption was checked without printing values. The age restore key is a private local file: it must be escrowed separately according to the owner's recovery process. Do not paste it or any environment secret into chat. `backup-manifest.json` contains ciphertext hashes and verification metadata only. Temporary restored production records were deleted from their local rehearsal replica sets after the reports were written; encrypted originals and production source data remain intact.

## Production readiness and exact remaining work

1. Read-only Atlas console review **passed**: FREE Cluster0 (512 MiB), four single-host /32 network entries including the VPS, no all-IPv4 entry, dedicated readWrite API identity scoped to meldiq and the explicitly named empty meldiq_rehearsal database. Driver TLS/certificate validation and pool 20 verified. Cloud backups are OFF, so establish recurring encrypted snapshots and separate restore-key escrow. Remove the unused rehearsal-database grant from the runtime identity after staging; keep rehearsal/migration access on a separate identity. platform_audit lacks its validator; arrange temporary schema-migration access for collMod without elevating the runtime API account. See atlas-control-plane-review.json and pending-schema-review.json.
2. Final Node 22 image checks passed against the restored dataset, including startup with all 16 domains, no persistent SQLite file, Redis ACL authentication and outage/recovery. Complete any remaining full-regression investigation and physical Android/web/admin smoke. Integrate concurrent newer API work before assigning a release version/image.
3. Redis is pinned to the official image digest and the synthetic/actual Compose merges are validated without starting services or changing production files. The pinned Redis image was started only on an isolated staging network: named-user authentication passed, unauthenticated commands were rejected, API health/admission returned 503 during its outage and recovered to 200 after restart. No production Redis service or paid service was provisioned.
4. Capacity estimate **fits**: ~207 MiB projected, below the ~358 MiB safety threshold. Atlas Free is limited to 100 read/write operations/second; pre-copy can take hours, so local rehearsal times cannot define the maintenance window. Use the paced copy command while SQLite remains authoritative, then a final freeze/delta/full comparison. Present the final reviewed conflict choice (archive both old target versions, retain SQLite's declared authority and its existing valid audit chain), verified final counts and reference-safe cutover plan. Obtain the execution prompt's required maintenance/cutover approval, freeze all writers, make fresh backups, migrate only pending domains, verify and switch to all-domain DATABASE_MODE=atlas plus Redis.
5. Keep SQLite files, conflict archives, original image/environment, backups and S3 objects through the approved recovery window. Dependency/data destruction is not authorized by this work. The optional separate federation-core SQLite registry is not deployed here; port it before enabling it under a claim of fully SQL-free ecosystem storage.

No legacy dependencies were removed: better-sqlite3, migrations and adapters still support recovery, tests, hybrid transition and the in-memory schema scaffold. The future step is removal after verified production cutover and recovery approval. The architecture remains one API business writer because existing MongoRows has a whole-domain read model; Redis does not make that model horizontally safe.

## Phase checklist

| Phase | Evidence / outcome | Remaining owner or execution action |
|---|---|---|
| Audit / ownership | Production counts, client/local-store inventory and dataset matrix completed | Refresh online counts at final freeze |
| Mongo design / Atlas | Existing IDs, schema, unique indexes, references and TLS retained/hardened; restricted network and roles reviewed | Temporary schema migration access for platform_audit; recurring backup policy |
| Redis | Shared lifecycle/cache/admission/presence/typing/PubSub and private Compose implemented | Approved production rollout after staging |
| Migration framework / consolidation | Batches/checkpoints, conflicts archived, high-water IDs, full checksums, delta-only writes and paced non-authoritative pre-copy | Production pre-copy and final delta not run |
| Backend / workers | All 16 active domains supported in Atlas mode with startup ownership guards; durable jobs stay in Mongo | Integrate current release and cut over one writer |
| Android / web / admin | Existing backend API, encrypted cache/outbox/import and key boundaries audited; 701 web/admin files passed driver-boundary checks | Physical device and signed-in client smoke at cutover |
| Security | TLS, no-secret diagnostics, no sensitive Redis content, current permissions checked before cached preferences | Separate backup-key escrow |
| Staging / tests | Restored-data checks and automated evidence below | Image/startup/outage checks passed; final regression outcome recorded below |
| Production migration | Prepared; production application data/configuration/services untouched by this work | Maintenance/cutover approval required by original execution prompt |
| Retirement | Original SQLite, image/environment, conflict originals and backups retained | Explicit recovery-window and destruction authorization after verified cutover |
| Scale | Bounded migration cursors and shared ephemeral coordination implemented | Existing whole-domain Rows read model remains one writer; redesign before horizontal scale |

The original prompt requires "Do not deploy breaking production changes without completing the staged migration and necessary approval" and "Production migration when authorized and safe." That gate is the reason the production authority switch is pending. Approval for cutover never implies approval to destroy originals.

## Exact Node 22 image rehearsal

The final API image builds on the VPS and includes the compiled diagnostic/migration CLI plus the BSON backup tool. Build TypeScript required a 1536 MiB heap in a 2 GiB build container; this setting applies only to compilation. The first 512 MiB compiler-heap attempt failed and was corrected without changing production services.

An isolated, unpublished Docker network on the VPS restored the same encrypted Atlas/SQLite snapshots. No container received production environment credentials or access to external services. The pending copy and unchanged rerun verified 625,346 records across 174 tables, zero missing declared references, the 183-row audit chain and two archived collision originals. The rerun performed zero document replacement writes. Runtime migration evidence is runtime-migration.json; restore checks are runtime-restore.json. Its ~329-second duration is for a local isolated MongoDB, not the throttled Atlas Free cluster.

The first full-data API attempt hit Node's automatically selected ~256 MiB heap ceiling. An explicit 384 MiB heap budget corrected that. Another attempt exposed ioredis URL auth taking precedence over the separately supplied password; the central client now merges the password into its private connection URL, and the named-ACL regression test uses that exact configuration. No credentials were logged.

The final Node v22.22.3 image passed /healthz and /v1/server-info with all 16 domains, Redis true, and no persistent SQLite opened. It passed within the old 512 MiB container at ~361 MiB retained RSS; other cold-start probes approached 460 MiB. The reviewed overlay raises the API cap to 768 MiB and keeps the heap at 384 MiB to leave room for request/crypto bursts. On that limit, the startup probe measured ~337 MiB RSS, Redis outage returned 503, and restart recovered both routes to 200. This is not a sustained-load certification. The added API allowance and Redis cap total 448 MiB above the old limits, within observed ~3.2 GiB available host memory; refresh capacity at rollout. See runtime-application.json, runtime-redis-recovery.json and actual-compose-validation.json.

The compiled plan command ran without network access and left the snapshot SHA-256 unchanged (runtime-cli.json). Final source-data comparison after application restarts and the Redis outage is recorded in runtime-final-verification.json. Temporary restored records and test Redis credentials are removed after the final comparisons; encrypted backups and the review image are retained.

Latest focused checks: **23 passed across 4 files**, including the named-ACL configuration, read-only CLI/explicit-apply guard, delta/idempotency/conflict/sequence safeguards and architecture boundaries. Evidence: tests-final-focused.txt. A separate CLI-only recheck passed after removing unnecessary eager feature imports from diagnostic startup.

## Concurrent production release integration

Production advanced independently to griip-internal-messaging-api:0.72.1-3c4d53a2 while this task was running. This work did not deploy it. The final candidate is integrated on 3c4d53a2, retaining PayPal recovery fixes, achievements/pin progress, message collections, optional derived _retrieval metadata and its three compound indexes. The overlapping billing trial assertion was resolved to keep current public-plan behavior plus the legacy-reference assertion. Current native feature data stays Atlas-authoritative and is excluded from SQL imports. API contracts were regenerated from that combined source. See current-build-source.json, current-production-state.json and current-image-build.txt.

Initial preparation backups and record counts predate that independent deployment. Fresh final backups/counts and a stable release baseline remain mandatory. Refuse rollout if the running API has advanced again until its changes are integrated. The 0.72.1 intermediate patch targeted 3c4d53a2; do not apply the original 0.71.1 candidate as a production replacement.

## Final 0.72.1 candidate verification

- **126 passed across 13 files**, no skipped tests, against the integrated candidate: Redis, migration CLI/safety, architectural boundaries, file/history/relay migration, account deletion, billing trials, PayPal mock-mode behavior, points and profile pins. Evidence: tests-current-release.txt.
- Production Node 22 image TypeScript/build passed on the exact combined source. A malformed connection-URI check also confirms constructor failures receive the generic sanitized error (current-error-redaction.json).
- Repeated the encrypted restore and full pending-domain migration on the VPS with the 0.72.1 image: **625,346 records across 174 tables**, exact counts/IDs/checksums/timestamps, zero declared reference failures, 183 valid audit-chain entries, two preserved conflict originals, and **zero document replacement writes on the identical rerun**. Local isolated migration/verify duration ~362 seconds, not an Atlas estimate. Evidence: current-runtime-restore.json and current-runtime-migration.json.
- Final combined-image API startup on those restored records passed both routes with Redis enabled, no persistent SQLite file and ~367 MiB retained RSS; evidence is current-runtime-application.json. The final image rechecks record integrity after startup in current-runtime-final-verification.json. Existing native Atlas collections and derived message metadata remain excluded from SQL imports.

The production-only dependency audit reported three existing package findings (one high, two moderate); those package versions are unchanged from production commit 3c4d53a2. No finding was reported for the newly added Redis packages. See dependency-audit.json for package names/advisory links. No unreviewed major dependency upgrade was included in this migration. These findings remain a security follow-up and are not counted as resolved.

Post-start comparison deliberately retains its raw exact-snapshot result (`ok=false`): API 0.72.1 adds one legitimate `telemetry_epochs` entry for `version:0.72.1`, absent from the older preparation snapshot. All 625,346 original records still have zero missing or differing rows; the only extra is that verified version marker (47 to 48 epochs). current-post-start-analysis.json confirms the expected bootstrap. Nothing was deleted, pruned or hidden to force equality. Strict count/checksum comparison passed before startup; final current production snapshots must be compared before admitting application writers.

## Final staging scope and 0.73.0 integration

After production advanced again to 0.73.0, the owner selected "Keep production moving; finish staging only." The final patch is pinned to 1e99c4ae / API 0.73.0, retaining its new leaderboard routes and native points/call aggregation reads. No new SQL table or persistent competing dataset was introduced by that release. Migration, catalog/schema, MongoRows, connection configuration and Redis components are byte-identical to the verified 0.72.1 candidate (release-integration-check.json). The final candidate will not automatically follow later deployments.

Any future production rollout is a separate controlled operation: compare/integrate the then-current release, refresh all backups/counts/capacity, obtain temporary schema access and the required maintenance approval, then run the documented pre-copy/final-delta/verification sequence. No further owner access is needed to finish this staging deliverable.

## Final 0.73.0 staged validation

The pinned candidate passed **141 tests across 14 files**, with no skips. The initial 0.73.0 integration exposed two architecture-test failures caused by the incoming leaderboard module's seven direct foreign imports and three table reads. These were corrected through public account/community/billing owner APIs while preserving its privacy, gift-refund, channel-visibility and ranking behavior. No allowlist or test was disabled. The complete affected release/migration run then passed (tests-latest-release.txt).

The exact final Node 22/0.73.0 image builds successfully (latest-image-build.txt, latest-build-source.json). Its isolated restored-data migration again verified all **625,346 rows across 174 tables**, zero missing declared relationships, the 183-row audit chain and two archived conflict originals; the repeated scan wrote zero documents. See latest-runtime-restore.json and latest-runtime-migration.json. Full-data application startup and its expected version-epoch addition are reported separately below.

The final 0.73.0 full-data startup passed /healthz and /v1/server-info with Redis enabled, all 16 domains, no persistent SQLite file and ~365 MiB retained RSS inside the proposed 768 MiB limit (latest-runtime-application.json). Post-start validation preserves every original row and separately verifies the expected version:0.73.0 telemetry marker, rather than deleting it to force snapshot equality (latest-post-start-verification.json). Atlas cold-start latency and sustained client load remain future rollout measurements.

Final cleanup removed the isolated MongoDB/Redis containers, their test volume/network, restored plaintext snapshot and generated Redis credentials. The source snapshot SHA-256 stayed unchanged through all reads. Encrypted originals, restore key and review images remain retained; no production cutover or source destruction occurred (latest-staging-cleanup.json).
