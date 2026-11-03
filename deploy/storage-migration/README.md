# Storage migration operator workflow

Run under the existing shared Meldiq production release lock and a separate exclusive destination-writer fence. Verify account, active API image and database authority. The regional migration helper will not make application or DNS changes. Never run it after Frankfurt starts accepting application writes.

1. Inspect the current media bucket, versions, markers, pending multipart uploads and live database references. The staged Frankfurt stack is orbit-storage-meldiq-frankfurt. Resolve the destination from its MediaBucket output. Do not supply a guessed name.
2. With an owner-only local state directory, run the following using a controlled AWS profile. Keep the same state and manifest across retries. This implementation is scoped to versioned SSE-S3 STANDARD versions no larger than the single-copy limit. It refuses unsupported versions. The tool never permanently deletes a version.

   ```sh
   umask 077
   uv run --with boto3 --with awscrt python deploy/storage-migration/reconcile.py --source "$SOURCE_BUCKET" --state "$STATE_DIR"
   ```
3. Historical disk files require separate handling. stage-local.cjs runs inside a network-restricted copy of the API runtime with a read-only data mount, an exact STAGE_IDS allowlist, the existing API environment and FRA_BUCKET from CloudFormation. Check each ID is active, absent from all source S3 history and present in the fallback volume. Capture stdout to an owner-only partial file and promote to disk-manifest.jsonl only after every expected row verifies. The API checks active IDs and bytes against Mongo before writing and verifies SHA-256 after a create-only upload. Do not use stale Atlas events after changing authoritative databases.
4. Before activating primary writes, block new and completing uploads, drain outstanding presigned grants and jobs, then rerun the copier with --reverify. Reconcile all current references against the final database. Enable only a versioned, compatible backend release and qualify private GET, HEAD, conditional and ranged delivery, message membership changes, client multipart resume, DNS and public health.
5. Store the S3 and disk manifests and current checkpoint in an encrypted recovery backup. On rollback, first use rollback-plan.py --state "$STATE_DIR" to calculate the reverse delta. Keep any post-cutover writes and deletions per the recovery report. Switching regions is never a recovery procedure by itself.
6. status-checks.json contains idempotent admin mutations for the existing independent status site. Apply components before probes. Do not create test incidents in production or declare either staged component active before the actual measurement arrives.

The media Worker configuration requires S3_ORIGIN and S3_PREFIX. Set MEDIA_EDGE_SECRET via Wrangler secrets, PROBE_KEY_ID and PROBE_KEY_SECRET only for the one-object probe identity. The application requires MEDIA_PUBLIC_BASE_URL, an independent 32-byte hex MEDIA_GRANT_KEY and the matching MEDIA_EDGE_SECRET. Never publish application keys to Worker variables, browsers, logs or Git. Keep these settings off on the primary until deployment and validation under the correct database authority.

Production activation used activate-postgres.py on the locked origin with the exact accepted PostgreSQL image as its base. Its input is protected controller JSON on SSH stdin. The controller verified the complete inventories at FROZEN, a real authorized Frankfurt range at CANDIDATE, and the production canary after OPEN. activate-atlas.py is historical and was never used for the final production activation. For operations after the switch see docs/infrastructure/migration/rollback-and-recovery.md.
