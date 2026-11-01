# Production execution — 2026-11-02

Status: authorized production pre-copy running. Production API remains 0.74.0 on its original eight Atlas domains and remaining SQLite authority. No cutover or write freeze has occurred. No owner input is currently required.

The owner's latest approval supersedes the earlier staging-only instruction. It authorizes preparation, production migration, controlled maintenance, deployment and recovery checks. It does not authorize deleting originals or backups or buying new subscriptions. Community terminology is preferred; existing orgId/org_id, APIs and identifiers remain compatible.

## Release and recovery baseline

- Current production: `griip-internal-messaging-api:0.74.0-social-8078f2bede40`, exact social-auth source imported as 89d1b586 and combined with the migration implementation. Branch `codex/atlas-production-cutover`, runtime candidate c87a8e58; operator backup scripts 60eb6af7.
- Current candidate: `griip-internal-messaging-api:0.74.0-atlas-c87a8e58`, built and typechecked on Node 22.22.3. It has not been deployed as the API.
- The shared production release flock is held by this migration. The profile release is preparing a combined 0.75.0 candidate, preserving deployed migration 085 and adding five new identity tables in 086. Final exact source/image and schema checks remain required before promotion.
- Latest online preparation backup: `/Users/nahian/.local/share/meldiq-migration/20261101T174639Z`. Atlas restore verified 80 collections and 50,455 records with exact BSON types, validators, indexes and checksums. SQLite quick_check passed. Environment, Compose and reports sealing key were encrypted and decryption checked. Federation is disabled, with no deployed federation key directory.
- This preparation snapshot is not mutually consistent across Atlas and SQLite. A fresh mutually consistent final snapshot after stopping writers is still required.
- Recovery key verified in macOS Keychain, service `Meldiq database recovery`, account `20261101T174639Z`, plus protected local file and root-only VPS recovery copy. Ciphertext bundles are retained on the VPS and mirrored to this Mac with SHA-256 checks. The Mac and code_files volume share one physical device; they count as one location.

## Verified pre-copy and rehearsal

| Check | Evidence |
|---|---|
| Source plan | 174 pending tables, 624,484 rows; excludes all already-authoritative Atlas domains and retired integration data |
| Read-only production preflight | 624,484 transformed; zero rejected; one differing target account_passkeys record reviewed for content-addressed archival before replacement |
| Audit schema preparation | Original inactive platform_audit record renamed into a preserved archive collection; count and exact BSON checksum matched; new strict target validator created without expanding runtime permissions |
| Full isolated migration | 174 tables / 624,484 rows; all counts, IDs and checksums matched; zero repeat writes; zero missing declared/same-community relationships |
| Audit chain | 184 records, zero invalid links/hashes |
| Atlas-only runtime | Health 200, server-info 200, all 16 domains, Redis connected; no persistent SQLite file; RSS 377,757,696 bytes under the proposed 768 MiB cap and 384 MiB heap |
| Batch resume tests | 27 passed across four files; includes acknowledged partial write-window interruption, safe resume, no duplicates, repeat writes zero |
| Combined social-auth integration | 72 passed across six files before the batching change; focused migration tests rerun after it; typecheck passed |
| Backup stream verifier | Current encrypted snapshot passed exact BSON checksums; truncated stream and missing-record stream both rejected |
| Full restored-data client behavior | Account/device setup, community isolation, Redis invalidation, message history/duplicate retries, E2EE WebSocket delivery, opaque attachment ownership/bytes and session revocation all passed in isolation |
| Full combined backend regression | Running; do not describe as passed until its complete result is recorded |

The isolated scratch MongoDB exited with code 139 once during schema preparation. It was restarted and its memory cap raised from 768 MiB to 1 GiB; the full copy/repeat/relationship/audit/runtime checks then passed. Production Atlas and the production API were unaffected. The crash's exact cause is not established.

## Live execution

Redis is running privately with ACL authentication, no host port, 128 MiB maxmemory and a 192 MiB container cap. The API was not recreated to start it. Prepared canonical Compose/environment files merge all 16 domains and Redis while preserving social-auth secrets, mounts, ports, LiveKit and ntfy; they have passed Compose validation but have not replaced live configuration.

Online copy uses immutable source SHA-256 c5b852aaa097625a18edad41cce8ab16154249393642e832fd5d89467537b639, bounded reads of 5,000, write chunks of 50 initially, then 75 after 173 successful health samples (worst 41 ms), and a one-second write delay. It changes no authority marker. A separate API health watchdog stops only its migration container after repeated health failures. Original API, SQLite source, backups, S3 objects and device E2EE keys remain intact.

Daily encrypted backup service/timer is installed and validated, but remains inactive until cutover. It runs the dump and verifier in separate resource-limited containers, checks every BSON checksum after encryption/decryption, commits completion manifests atomically and never automatically deletes backups. The hourly Mac mirror is installed and has verified its first bundle; it copies ciphertext only. Atlas's optional paid Free-cluster backup preview remains disabled; no S3 backup objects or new paid services were created.

## Remaining execution gates

1. Finish online copy and rolling incremental passes while the original API serves.
2. Complete the combined profile candidate's schema/startup/regression review and full backend regression.
3. Prepare a graceful proxy maintenance response; confirm no active calls, pause requests, drain/stop every API writer, and create fresh consistent encrypted backups.
4. Apply the final bounded delta with conflict archival and reviewed pruning; verify IDs/counts/checksums, tenant references, audit chain, timestamps and capacity. Promote only the eight pending domain authority markers in one transaction.
5. Start the combined candidate with canonical all-domain Atlas/Redis configuration, verify health and application behavior, then reopen requests. Preserve all original SQLite and recovery material.
6. Activate and test recurring backups and the off-host mirror, verify a post-cutover restore, record a final receipt and release the shared deployment lock.

After Atlas accepts new writes, recovery must retain Atlas authority. Never restore stale SQLite as authority. The c87 Atlas-only candidate is the verified migration fallback; the original pre-migration image is retained for pre-promotion recovery and compatibility evidence. It must not be treated as an Atlas-only rollback certificate simply because a health probe succeeded.

ADB is available but no Android device is connected; a physical signed-in Android device smoke has not been performed. Live buyer charges are excluded; automated billing/entitlement checks and preserved provider identifiers are used. Remaining cache/outbox/device-key SQLite is intentional and is not a competing server authority. Legacy source files and dependencies remain available for recovery/tests and the in-memory schema scaffold, with no original destruction authorized.
