# Rollback plan

Retain the image actually running at the final freeze (latest observed during integration `griip-internal-messaging-api:0.73.0-1e99c4ae`; initial preparation used 0.71.1-smooth), original environment, Compose file, SQLite source and encrypted Atlas backup. Current production has not been cut over by this work.

Before any write freeze, verify an encrypted Atlas restore into an **empty local scratch** database using the supplied backup tool, including BSON type, count, checksum, validator and index comparisons. SQLite quick_check must pass. Store/escrow the age private key separately from the encrypted backup; never paste it into chat or Git.

If a migration fails before the new API accepts writes, stop migration, retain partial Atlas copies/checkpoints and all conflict archives, and restore the original configured domains and image. Reconcile/rollback any newly written authority markers before starting the old configuration; its startup guards intentionally refuse a stale SQLite fallback. Do not roll back any domain that was already authoritative in Atlas before this migration.

If the new API has accepted writes, the old SQLite file is stale. Freeze every writer again. Use the reviewed Mongo-to-SQLite export for the newly moved domains in reverse dependency order, or restore a mutually consistent verified Atlas image and retain Atlas as authority. The exporter validates source/target counts and foreign keys and backs up SQLite first; its memory requirement must be measured for this source. Never restore an old SQLite snapshot over live Atlas data or delete new collections merely to silence an ownership guard.

Redis is disposable. Stop the new API before removing the Redis overlay if reverting to an API image without it. Do not reopen abuse-protected routes while a Redis-configured API silently loses distributed admission. Mongo business data, pending deliveries, billing events and job outcomes must survive a complete Redis flush/restart.

Rollback completion requires health, authentication/refresh, account revocation, DM/channel history/order, community permissions, billing entitlements, admin audit, object downloads and job recovery checks. Keep backup/source/conflict archives until the owner explicitly authorizes retirement. Do not delete S3 objects, client secure keys, or mobile unsent work during rollback.
