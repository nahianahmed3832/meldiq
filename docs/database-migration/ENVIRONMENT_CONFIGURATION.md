# Environment configuration

Server-only variables; real values stay in the existing private environment/secrets store. Browser and Android clients get only API/WebSocket endpoints and public application settings. Do not add public MONGODB/REDIS variables to the web .env.example.

| Variable | Purpose / safe example |
|---|---|
| APP_ENV / NODE_ENV | production activates Mongo TLS and Redis transport checks |
| MONGODB_URI | `mongodb+srv://app:REPLACE_SECURELY@cluster.example.invalid/` (placeholder only) |
| MONGODB_DB | `meldiq`; preserve the existing project convention |
| MONGODB_DOMAINS | all active domains after verified cutover; preserve current subset during preparation |
| MONGODB_MAX_POOL | existing default 20, bounded to 200; leave cluster connection headroom |
| MONGODB_TIMEOUT_MS | existing default 5000, bounded |
| MONGODB_STORAGE_LIMIT_MB | required for a production copy; configured actual cluster capacity; retain the 70% migration safety headroom |
| DATABASE_MODE | `hybrid` during preparation; `atlas` only after every verified authority marker exists |
| REDIS_URL | `rediss://meldiq@redis.example.invalid:6379/0`; Compose uses `redis://meldiq@redis:6379/0` on private network |
| REDIS_PASSWORD | generated into private .env.redis or supplied by secret storage; never printed |
| REDIS_KEY_PREFIX | `meldiq:production:v1`; different prefix in staging and tests |
| MELDIQ_NODE_OPTIONS | Compose API heap budget, default `--max-old-space-size=384` with the reviewed 768 MiB API cap; preserve required extra flags here |
| REDIS_TIMEOUT_MS | default 1000; 100–5000 ms allowed |
| REDIS_PRIVATE_NETWORK | default false; true only for the verified private Docker deployment |
| RESTORE_MONGODB_URI | local replica-set URI only, explicit port; restore tool rejects remote targets |
| RESTORE_MONGODB_DB | must start `meldiq_restore_`; must be empty |

Target domains: `accounts,preferences,history,reports,relationships,relay,files,calls,workspace,conversations,billing,safety,platform,federation,ephemeral,identity`.

The root/deploy backend env examples have safe names/placeholders only. Redis ACL configuration is generated at deployment, not committed. Existing S3 credentials, keys and object metadata remain in their current secure backend configuration; no new AWS permissions or infrastructure is requested. Do not enable broad Atlas network access to make a failing connection succeed.

Safe diagnostics never print the URI, driver error string, environment values, message bodies, auth codes, token hashes, passkey keys or backup-key material. The backup stream itself contains sensitive data and must go directly to age encryption or a restricted temporary restore environment, never to the chat/tool output or a Git artifact.

Production Atlas mode also requires REDIS_URL. Setting APP_ENV to development cannot weaken transport validation when NODE_ENV is production. The optional undeployed federation-core registry still has a SQLite implementation and is explicitly excluded from a claim of complete SQL dependency removal.

Atlas console review confirmed the runtime account has readWrite on meldiq and the empty meldiq_rehearsal database, scoped to one cluster. Keep schema-altering privileges on a separate temporary migration identity; platform_audit currently lacks its required validator. Existing unrelated Atlas administrative users were not modified.

At final rollout, narrow the runtime identity to the production meldiq database and remove the unused rehearsal-database grant. Use a separate staging identity if Atlas rehearsal is later required. The review itself made no role changes.
