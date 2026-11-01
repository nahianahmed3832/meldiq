# MongoDB architecture

## Ownership and compatibility

MongoDB Atlas is the target durable owner for every active application domain. Preserve the existing table-shaped snake_case collections and native feature collections; do not create a parallel `communities` collection while `orgs` exists. “Community” is the preferred product term. `org_id`, `orgId`, `/v1/orgs`, and the `workspace` domain are compatibility identifiers, retained for released Android/web/admin clients and future Windows clients.

Routes authenticate and authorize through AppContext services. The deployed-compatible backend already implements Mongo stores for accounts, preferences, history/message events, reports, relationships, relay, files and calls; Rows stores cover communities, conversations, billing, identity, safety, federation, platform and temporary state. Native collections remain owned by their existing feature service (points, rules, pins, decorations, OAuth, bots, linked accounts). DATABASE_AUDIT and DATA_OWNERSHIP_MATRIX enumerate every observed dataset.

## Schema, references and indexes

`server/src/infrastructure/database/schema.generated.ts` is the checked-in schema. `mongo/catalog.ts` assigns ownership, transforms embedded preference JSON, preserves binary values, original primary keys (including composite IDs), timestamps, nullability, default values, unique and partial indexes and case-insensitive constraints. Schema generation remains a development/migration task; do not infer a new production schema from an empty database. `ensureSchema` now bounds DDL concurrency to four collections. Schema-changing `collMod` uses a migration credential; a runtime readWrite credential must not be elevated to an Atlas administration role.

Validators require the actual business fields and BSON types. SQL UNIQUE/partial indexes become Mongo unique/partial indexes; composite identities keep their original field order. Existing native feature validators and indexes are preserved. Message stores retain their bounded history/cursor queries and stable timestamp/ID ordering; no message body is copied into Redis. Review explain plans on staging before adding indexes; do not add community/user fields blindly to global catalogs or account records.

`validateRelationships` checks declared foreign keys and same-community ownership where parent and child both carry org_id, using bounded server-side lookups. Validation reports counts only. Audit chain verification recomputes hashes without publishing audit entries. A missing relationship is a failed cutover gate; automatic reassignment, fabrication of missing users, or orphan deletion is prohibited. Repair requires choosing the actual authoritative record, then rerunning validation. Native feature references still require service-specific behavior tests in addition to this generic schema check.

## Startup, transactions and errors

`DATABASE_MODE=hybrid` supports the current controlled transition. `DATABASE_MODE=atlas` requires every active domain in MONGODB_DOMAINS and a verified MongoDB authority marker for each. It opens only an in-memory SQLite schema scaffold; the legacy persistent file is not opened by the API. No SQLite fallback follows an Atlas outage. Keep the native SQLite library and SQL migrations for source extraction, rollback, tests and the in-memory compatibility scaffold; they are not yet removable dependencies. Normal operator CLI operations also use the scaffold in Atlas mode; explicit Mongo migration commands can inspect retained source files. SQLite-only backup commands refuse Atlas mode.

One pooled Mongo client per API, majority read/write concerns, bounded selection/connect/socket timeouts, retryable reads/writes, driver-managed transaction retries and AsyncLocalStorage sessions remain in use. Multi-document transactions cover existing atomic business operations, rather than every read. Shutdown waits for pending units, closes change streams, Redis clients and the Mongo client. New TLS validation rejects SRV URLs explicitly disabling TLS and invalid-certificate/hostname bypasses in production; NODE_ENV=production now also activates these checks. Connection diagnostics do not print URIs or driver error strings.

## Capacity and concurrency limits

Existing MongoRows uses a whole-domain in-memory read model. It retains a single-writer API assumption and refreshes operator changes through change streams. Redis HTTP coordination does **not** make concurrent business writers or read models safe for arbitrary horizontal scaling. In particular, quotas, AUTOINCREMENT allocation and multi-document business conditions still need async indexed repositories or explicit fencing before additional API writers are enabled. Keep one API instance during cutover and measure RSS against the reviewed 768 MiB deployment cap. More than 600k temporary telemetry rows exist in the observed source; do not label this implementation unbounded-scale ready.

Verification and prune now stream bounded cursor batches and perform indexed source lookups, rather than retaining all source IDs or entire message histories. Rollback still materializes selected domain records and must be rehearsed against the measured data volume. Complete SQL dependency retirement and optional federation-core storage conversion remain separate work until all recovery paths are proven.

## Retention, backup and restoration

Existing application retention and account/community deletion policies remain authoritative; migration preserves timestamps and never resets expiry. New conflict archives are administrative migration records in Atlas and must be retained through the approved rollback window. S3 bytes and object references remain unchanged. See ROLLBACK_PLAN and PRODUCTION_RUNBOOK for encrypted backups, restore evidence and the final write freeze. Backup scripts preserve exact BSON types, collection validators, indexes and per-collection checksums in a single Atlas read snapshot.

## Identifier high-water marks

The migration also transfers SQLite AUTOINCREMENT sequence floors into orbit_meta using both existing allocator conventions (`value` for Rows, `seq` for the relay). Deleted highest-ID rows must not cause an Atlas-only process with an empty SQL scaffold to reuse an ID. A regression test deletes the highest SQLite row and verifies the next MongoDB insert receives a strictly larger ID.

## Measured restored-data startup

The second local rehearsal forced garbage collection before measuring retained state. With all 625,346 remaining records consolidated, API health and server info returned 200 and no persistent SQLite file was opened. Measured RSS 311,738,368 bytes (~297 MiB), heap 271,164,216 bytes (~259 MiB). Before application startup the rehearsal process already retained 132,174,168 heap bytes, so this is not a fresh-process throughput/peak-memory measurement. It is evidence of successful startup, not a substitute for the exact Node 22 production image's 512 MiB container test under load. Consider an explicit, reviewed Node heap budget and retain the single-writer restriction.

## Atlas Free and final-pass throughput

The console showed 43.31 MiB in use. Estimated additional BSON plus indexes is 171,703,020 bytes, giving 217,116,847 projected bytes (~207 MiB), below the 70%-of-512-MiB threshold (~358 MiB). This is an estimate, not a growth guarantee; refresh before copying. See capacity-estimate.json.

[Atlas Free limitations](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) specify 100 read/write operations per second and throttling. Local rehearsal duration does not predict an Atlas maintenance window. The compiled copy command defaults to 50-row batches with a one-second delay after batches containing writes; actual available throughput must be observed without starving the API. Every repeat pass scans and checks the source, queries at most one batch of destination records, and writes only changed/missing documents. Unchanged records produce zero replacement writes. Pre-copy does not change authority markers. A final immutable snapshot, write freeze, reviewed deletions/conflicts and complete verification remain necessary.

The read-only metadata review found platform_audit needs collMod to install its validator. Use a temporary narrowly scoped schema-migration user (or an owner-applied schema change), then revoke that access. Do not elevate the runtime API account. The existing account_passkeys validator already matches. See pending-schema-review.json.

The exact Node v22.22.3 image subsequently passed full-data startup with a 384 MiB heap inside a 512 MiB test container (~361 MiB retained RSS). Cold-start RSS varied up to ~460 MiB, so the deployment overlay allocates 768 MiB to the API with the same 384 MiB heap on the existing host. Redis restart/outage checks passed at that proposed limit. Keep one writer and perform client/load checks before treating this as production capacity certification; runtime-application.json and runtime-redis-recovery.json contain the measured values.
