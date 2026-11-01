# Meldiq database audit — 2026-11-01

Status: discovery complete for the current deployment; complete cutover is NOT yet verified.

## Evidence and source selection

Read-only SSH inspection of Hostinger's running API image `griip-internal-messaging-api:0.71.1-smooth` confirmed MongoDB connectivity, S3 configuration, and no REDIS_URL. API and ntfy were healthy; LiveKit running. Inventory was captured at 2026-11-01T13:33:20.525Z. Counts are observations of a running service, not a mutually consistent migration snapshot. No credentials or document contents were printed. `production-inventory.json` contains counts and declared relationships only.

The web root and Android root are older, heavily modified working copies. The production-compatible source is commit `d7fd6b31` (includes deployed `1b99c5f6`), inspected at `/Volumes/code_files/meldiq_android/.claude/worktrees/yapin-reliability`. New implementation is isolated at `/Volumes/code_files/meldiq_database_migration` on `codex/unified-atlas-redis`. The separate 0.72 API source artifact belongs to ongoing message retrieval work and is not the production baseline. Do not deploy the root backend's 0.54 code over production.

## Persistence inventory

- **MongoDB Atlas, database meldiq**: authoritative for accounts, preferences, encrypted history, messages, reports, relationships, relay, file metadata and billing; native feature collections below also use MongoDB. Observed 78 collections, 31904349 data bytes and 13225984 index bytes. Read-only Atlas console review subsequently confirmed Cluster0 FREE (512 MiB), four single-host /32 access entries including the VPS, no 0.0.0.0/0 entry, and the dedicated API user with readWrite on meldiq and the empty meldiq_rehearsal database. Cloud backups are OFF; encrypted owner-managed snapshots are required. See atlas-control-plane-review.json.
- **Server SQLite `/data/griip.sqlite`**: authoritative for remaining domains below, plus stale pre-cutover copies of MongoDB data. File 75988992 bytes; quick_check reported ok. Removing it now breaks authentication identity/device reads, communities and access control, calls, platform admin, quotas, telemetry, federation and account safety.
- **Android SQLCipher/Room**: `meldiq_android/android/app/src/main/java/com/meldiq/android/data/db/Database.kt`; message/conversation working cache, outbox, pending controls and held delivery. Retain unsent work and legacy import until acknowledged. Device keys belong to Keystore/device storage, never Redis or plaintext Atlas. No device DB was connected; counts unavailable. The migration must preserve the released API, which already supports server history and import.
- **Web IndexedDB orbit-web**: `src/store/db.ts`, sealed device/session records and startup snapshot; old message stores retained for authenticated legacy import (`src/sync/legacyImport.ts`). Current working messages/outbox are in memory. Keep device keys and sealed tokens here; deleting old stores before import acknowledgements loses history.
- **Web Cache Storage / localStorage / sessionStorage**: service worker shell/assets, bounded media cache, appearance, navigation positions, consent/checkout drafts and redirect state. These are disposable caches or device preferences, not a competing server database. Inspect `src/sw`, `src/store/mediaCache.ts`, `src/application/prefs.ts`, `src/ui/billing/checkoutDraft.ts`. Firebase is push transport, not an application database.
- **Admin**: separate Vite/React client `meldiq_central_admin`, authenticated `/admin/v1` backend; theme preference is device-only. Backend platform domain is the authority, currently SQLite. No admin-specific database driver in its package.
- **S3**: binary objects remain in S3, ownership/object references in file metadata. Disk fallback remains configured; do not delete files until object reconciliation succeeds.
- **ntfy SQLite volumes**: service-owned access and temporary wake-up cache, not Meldiq business records. Leave service operational; do not migrate third-party internals into Atlas.
- **Tests**: better-sqlite3 in-memory/temp files and mongodb-memory-server replica set; synthetic, independently disposable. Existing MongoRows uses whole-domain in-memory read models and change streams; this is a scalability constraint, not a second durable authority. It must remain single API writer until concurrency is redesigned.
- **Other directories/worktrees**: old Orbit repos, bot loadtest clones, build artifacts and deployment backups are historical copies or test clients; never silently merge their data into production. Windows implementation is not present; existing HTTPS/WebSocket contracts remain reusable.

## Server table inventory

Names such as `orgs`, `org_id`, `orgId`, and `workspace` are compatibility identifiers for **communities**. New explanatory text uses communities; existing routes, IDs and collection names are preserved.

| Dataset / collection | Domain | Current authority | SQLite rows | Atlas rows | Migration |
|---|---|---|---:|---:|---|
| `abandoned_uploads` | files | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `account_codes` | accounts | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `account_email_changes` | safety | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `account_key_backups` | accounts | MongoDB Atlas | 9 | 14 | Do not recopy stale SQLite |
| `account_key_unlocks` | accounts | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `account_passkey_challenges` | safety | SQLite | 7 | 0 | Yes; verify destination collisions first |
| `account_passkeys` | safety | SQLite | 1 | 1 | Yes; verify destination collisions first |
| `account_recovery_codes` | accounts | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `account_recovery_tickets` | accounts | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `account_session_factors` | accounts | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `account_sessions` | accounts | MongoDB Atlas | 35 | 67 | Do not recopy stale SQLite |
| `account_totp` | safety | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `account_totp_backup` | safety | SQLite | 10 | 0 | Yes; verify destination collisions first |
| `account_warnings` | safety | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `accounts` | accounts | MongoDB Atlas | 19 | 26 | Do not recopy stale SQLite |
| `activity_daily` | platform | SQLite | 93 | 0 | Yes; verify destination collisions first |
| `ai_agent_channels` | platform | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `ai_agent_identities` | platform | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `ai_agent_installs` | platform | SQLite | 16 | 0 | Yes; verify destination collisions first |
| `ai_agent_templates` | platform | SQLite | 21 | 0 | Yes; verify destination collisions first |
| `ai_approvals` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_channel_context` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_channel_posts` | platform | SQLite | 6 | 0 | Yes; verify destination collisions first |
| `ai_channel_readers` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_files` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_job_events` | platform | SQLite | 49 | 0 | Yes; verify destination collisions first |
| `ai_jobs` | platform | SQLite | 8 | 0 | Yes; verify destination collisions first |
| `ai_model_capabilities` | platform | SQLite | 8 | 0 | Yes; verify destination collisions first |
| `ai_models` | platform | SQLite | 6 | 0 | Yes; verify destination collisions first |
| `ai_org_entitlements` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_providers` | platform | SQLite | 2 | 0 | Yes; verify destination collisions first |
| `ai_reader_choices` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_reader_events` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_routing` | platform | SQLite | 7 | 0 | Yes; verify destination collisions first |
| `ai_shared_messages` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_system_checks` | platform | SQLite | 13 | 0 | Yes; verify destination collisions first |
| `ai_task_events` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_task_settings` | platform | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `ai_tasks` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_tool_policies` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_triggers` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `ai_usage` | platform | SQLite | 29 | 0 | Yes; verify destination collisions first |
| `alert_deliveries` | platform | SQLite | 5 | 0 | Yes; verify destination collisions first |
| `alert_rules` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `alert_state` | platform | SQLite | 15 | 0 | Yes; verify destination collisions first |
| `analytics_daily` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `api_keys` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `attachment_uploads` | files | MongoDB Atlas | 0 | 1 | Do not recopy stale SQLite |
| `attachments` | files | MongoDB Atlas | 285 | 450 | Do not recopy stale SQLite |
| `audit_log` | workspace | SQLite | 1266 | 0 | Yes; verify destination collisions first |
| `auth_challenges` | ephemeral | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `billing_checkouts` | billing | MongoDB Atlas | 0 | 3 | Do not recopy stale SQLite |
| `billing_customers` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `billing_grant_notes` | billing | MongoDB Atlas | 0 | 11 | Do not recopy stale SQLite |
| `billing_grants` | billing | MongoDB Atlas | 0 | 18 | Do not recopy stale SQLite |
| `billing_invoices` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `billing_payment_actions` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `billing_plan_versions` | billing | MongoDB Atlas | 0 | 2 | Do not recopy stale SQLite |
| `billing_plans` | billing | MongoDB Atlas | 0 | 2 | Do not recopy stale SQLite |
| `billing_play_purchases` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `billing_program` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `billing_provider_events` | billing | MongoDB Atlas | 0 | 5 | Do not recopy stale SQLite |
| `billing_referral_codes` | billing | MongoDB Atlas | 0 | 12 | Do not recopy stale SQLite |
| `billing_referrals` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `billing_subscription_history` | billing | MongoDB Atlas | 0 | 3 | Do not recopy stale SQLite |
| `billing_subscriptions` | billing | MongoDB Atlas | 0 | 3 | Do not recopy stale SQLite |
| `billing_webhook_rejections` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `bot_afk` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `bot_alert_watches` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `bot_giveaways` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `bot_levels` | workspace | SQLite | 4 | 0 | Yes; verify destination collisions first |
| `bot_listings` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `bot_runtime_events` | workspace | SQLite | 25 | 0 | Yes; verify destination collisions first |
| `bot_starboard` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `bot_wordy_games` | workspace | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `bot_wordy_recaps` | workspace | SQLite | 2 | 0 | Yes; verify destination collisions first |
| `bot_wordy_stats` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `branch_members` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `branches` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `bug_reports` | safety | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `call_hands` | calls | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `call_participants` | calls | SQLite | 237 | 0 | Yes; verify destination collisions first |
| `calls` | calls | SQLite | 139 | 0 | Yes; verify destination collisions first |
| `channel_categories` | workspace | SQLite | 40 | 0 | Yes; verify destination collisions first |
| `channel_options` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `channel_overwrites` | workspace | SQLite | 2 | 0 | Yes; verify destination collisions first |
| `channel_webhooks` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `community_discovery` | workspace | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `community_expressions` | workspace | SQLite | 24 | 0 | Yes; verify destination collisions first |
| `community_lobbies` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `community_lobby_feeds` | workspace | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `community_lobby_posts` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `community_lobby_seen` | workspace | SQLite | 14 | 0 | Yes; verify destination collisions first |
| `community_member_defaults` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `community_migration_runs` | workspace | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `community_onboarding` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `community_profiles` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `community_safety` | workspace | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `community_settings` | workspace | SQLite | 2 | 0 | Yes; verify destination collisions first |
| `community_standard_invites` | workspace | SQLite | 3 | 0 | Yes; verify destination collisions first |
| `community_templates` | workspace | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `community_tickets` | workspace | SQLite | 2 | 0 | Yes; verify destination collisions first |
| `community_vanity_invites` | workspace | SQLite | 2 | 0 | Yes; verify destination collisions first |
| `community_voice_bans` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `community_voice_mutes` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `connections` | relationships | MongoDB Atlas | 6 | 8 | Do not recopy stale SQLite |
| `conversation_members` | conversations | SQLite | 1172 | 0 | Yes; verify destination collisions first |
| `conversations` | conversations | SQLite | 194 | 0 | Yes; verify destination collisions first |
| `delivery_queue` | relay | MongoDB Atlas | 17873 | 40152 | Do not recopy stale SQLite |
| `departments` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `devices` | identity | SQLite | 121 | 0 | Yes; verify destination collisions first |
| `discord_connections` | workspace | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `discord_import_items` | workspace | SQLite | 271 | 0 | Yes; verify destination collisions first |
| `discord_imports` | workspace | SQLite | 5 | 0 | Yes; verify destination collisions first |
| `discord_oauth_states` | ephemeral | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `discovery_boosts` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `discovery_clicks` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `discovery_visits` | workspace | SQLite | 6 | 0 | Yes; verify destination collisions first |
| `dm_requests` | relationships | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `document_comments` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `document_members` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `document_versions` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `documents` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `fcm_tokens` | identity | SQLite | 10 | 0 | Yes; verify destination collisions first |
| `federation_blocks` | federation | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `federation_domains` | federation | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `federation_inbox` | federation | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `federation_nonces` | ephemeral | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `federation_outbox` | federation | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `federation_peers` | federation | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `history_accounts` | history | MongoDB Atlas | 12 | 12 | Do not recopy stale SQLite |
| `history_items` | history | MongoDB Atlas | 2035 | 2907 | Do not recopy stale SQLite |
| `inbox_accounts` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `inbox_contacts` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `inbox_conversations` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `inbox_events` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `inbox_messages` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `inbox_queues` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `inbox_settings` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `integration_accounts` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `integration_channel_events` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `integration_credentials` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `integration_deliveries` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `integration_hooks` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `integration_installs` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `integration_jobs` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `integration_oauth_states` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `integration_policies` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `integration_subscriptions` | integrations | Retained archive (SQLite) | 0 | 0 | Archive decision required |
| `invitations` | workspace | SQLite | 33 | 0 | Yes; verify destination collisions first |
| `join_applications` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `legacy_tickets` | accounts | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `loadtest_registrations` | identity | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `meeting_participants` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `meetings` | workspace | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `mention_all_events` | conversations | SQLite | 4 | 0 | Yes; verify destination collisions first |
| `message_events` | history | MongoDB Atlas | 0 | 2672 | Do not recopy stale SQLite |
| `messaging_settings` | relationships | MongoDB Atlas | 0 | 1 | Do not recopy stale SQLite |
| `mojo_controls` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `mojo_gifts` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `mojo_profile` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `nav_preferences` | preferences | MongoDB Atlas | 4 | 9 | Do not recopy stale SQLite |
| `official_bots` | workspace | SQLite | 16 | 0 | Yes; verify destination collisions first |
| `official_bots_plus` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `onboarding_answers` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `onboarding_completions` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `operator_accounts` | platform | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `org_bans` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `org_deletions` | workspace | SQLite | 9 | 0 | Yes; verify destination collisions first |
| `org_entitlements` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `org_members` | workspace | SQLite | 45 | 0 | Yes; verify destination collisions first |
| `org_nicknames` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `org_role_extras` | workspace | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `org_role_members` | workspace | SQLite | 30 | 0 | Yes; verify destination collisions first |
| `org_roles` | workspace | SQLite | 30 | 0 | Yes; verify destination collisions first |
| `orgs` | workspace | SQLite | 12 | 0 | Yes; verify destination collisions first |
| `pairing_requests` | ephemeral | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `pending_blob_deletes` | files | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `platform_admin_challenges` | ephemeral | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `platform_admin_enrolments` | ephemeral | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `platform_admin_passkeys` | platform | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `platform_admin_sessions` | ephemeral | SQLite | 5 | 0 | Yes; verify destination collisions first |
| `platform_admins` | platform | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `platform_audit` | platform | SQLite | 183 | 1 | Yes; verify destination collisions first |
| `platform_incident_events` | platform | SQLite | 124 | 0 | Yes; verify destination collisions first |
| `platform_incidents` | platform | SQLite | 5 | 0 | Yes; verify destination collisions first |
| `platform_report_cases` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `platform_report_events` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `platform_restrictions` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `platform_settings` | platform | SQLite | 5 | 0 | Yes; verify destination collisions first |
| `presence_hourly` | platform | SQLite | 208 | 0 | Yes; verify destination collisions first |
| `presence_samples` | ephemeral | SQLite | 12472 | 0 | Yes; verify destination collisions first |
| `promoted_bookings` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `push_endpoints` | identity | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `quota_counters` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `quota_events` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `quota_plan_members` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `quota_plans` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `quota_policies` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `quota_reservations` | platform | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `reaction_roles` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `registration_invites` | identity | SQLite | 1 | 0 | Yes; verify destination collisions first |
| `reminder_occurrences` | identity | SQLite | 2 | 0 | Yes; verify destination collisions first |
| `reminders` | identity | SQLite | 2 | 0 | Yes; verify destination collisions first |
| `reports` | reports | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `resource_hourly` | platform | SQLite | 12688 | 0 | Yes; verify destination collisions first |
| `resource_samples` | ephemeral | SQLite | 593274 | 0 | Yes; verify destination collisions first |
| `session_clients` | platform | SQLite | 58 | 0 | Yes; verify destination collisions first |
| `sessions` | ephemeral | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `spark_assignments` | billing | MongoDB Atlas | 0 | 10 | Do not recopy stale SQLite |
| `spark_purchases` | billing | MongoDB Atlas | 0 | 0 | Do not recopy stale SQLite |
| `stage_speakers` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `submitted_messages` | relay | MongoDB Atlas | 2031 | 2777 | Do not recopy stale SQLite |
| `team_members` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `teams` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `telemetry_epochs` | platform | SQLite | 47 | 0 | Yes; verify destination collisions first |
| `ticket_panels` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `tickets` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `traffic_user_daily` | platform | SQLite | 409 | 0 | Yes; verify destination collisions first |
| `usage_daily` | workspace | SQLite | 475 | 0 | Yes; verify destination collisions first |
| `user_blocks` | identity | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `user_group_members` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `user_groups` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `users` | identity | SQLite | 65 | 0 | Yes; verify destination collisions first |
| `webhook_deliveries` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `webhooks` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `workflow_runs` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |
| `workflows` | workspace | SQLite | 0 | 0 | Yes; verify destination collisions first |

## Native collections already in Atlas

| Collection | Rows | Owner |
|---|---:|---|
| `points_accounts` | 8 | Atlas; preserve existing native service or migration metadata |
| `username_holds` | 1 | Atlas; preserve existing native service or migration metadata |
| `points_days` | 23 | Atlas; preserve existing native service or migration metadata |
| `oauth_apps` | 1 | Atlas; preserve existing native service or migration metadata |
| `creator_posts` | 0 | Atlas; preserve existing native service or migration metadata |
| `decoration_favorites` | 0 | Atlas; preserve existing native service or migration metadata |
| `points_ledger` | 101 | Atlas; preserve existing native service or migration metadata |
| `user_activities` | 0 | Atlas; preserve existing native service or migration metadata |
| `oauth_codes` | 0 | Atlas; preserve existing native service or migration metadata |
| `orbit_meta` | 39 | Atlas; preserve existing native service or migration metadata |
| `linked_account_starts` | 0 | Atlas; preserve existing native service or migration metadata |
| `bots` | 1 | Atlas; preserve existing native service or migration metadata |
| `billing_checkouts_pre_paypal_20261101` | 0 | Atlas; preserve existing native service or migration metadata |
| `community_pin_awards` | 0 | Atlas; preserve existing native service or migration metadata |
| `community_pins` | 0 | Atlas; preserve existing native service or migration metadata |
| `community_rules` | 1 | Atlas; preserve existing native service or migration metadata |
| `creator_verifications` | 1 | Atlas; preserve existing native service or migration metadata |
| `creator_program` | 0 | Atlas; preserve existing native service or migration metadata |
| `profile_decorations` | 0 | Atlas; preserve existing native service or migration metadata |
| `mojo_gifts_pre_paypal_20261101` | 0 | Atlas; preserve existing native service or migration metadata |
| `linked_accounts` | 0 | Atlas; preserve existing native service or migration metadata |
| `community_rule_agreements` | 1 | Atlas; preserve existing native service or migration metadata |
| `points_invites` | 1 | Atlas; preserve existing native service or migration metadata |
| `oauth_grants` | 0 | Atlas; preserve existing native service or migration metadata |
| `oauth_tokens` | 0 | Atlas; preserve existing native service or migration metadata |
| `bot_interactions` | 0 | Atlas; preserve existing native service or migration metadata |

## Findings affecting cutover

1. Existing MongoDB copies are ahead of SQLite. A whole-SQLite export would erase valid accounts, messages, billing and history. Migration must exclude already authoritative domains, regardless of table names or old checkpoints.
2. `account_passkeys` and `platform_audit` already contain Atlas documents despite SQLite ownership. Compare documents without printing sensitive fields; refuse blind replacement. Never automatically deduplicate passkeys or rewrite a hash-chained audit.
3. Approximately 606k temporary rows (primarily telemetry) dominate the remaining copy and memory budget. Expiry must be measured, not silently applied during migration. Full-domain read models cannot scale without bounding or replacing them with async indexed repositories.
4. Existing verification loads entire ID/hash maps into memory; existing prune retains every source ID. Replace these with bounded comparisons. Existing dry-run creates destination schemas and its override can drop preexisting rehearsal collections; use a unique scratch database and an empty-destination guard.
5. Existing `mongo-migrate` accepts an already authoritative domain and uses replacement upserts. Add a refusal before copying to protect live Atlas records.
6. Existing TLS inference accepts SRV URLs even with tls=false and allows insecure certificate overrides. Reject these in production and remove URI/error values from connection diagnostics.
7. In-memory rate limits and real-time hub assume one API process. Redis coordination can share transient state; it does not make snapshot-based business writes safe across processes.
8. No fresh verified off-host backup, restore rehearsal, or current Atlas network/role inspection has yet been evidenced. Existing notes mention Atlas M0 without cloud backup. Production cutover remains gated on those checks and a concrete approved maintenance window.
9. Unversioned generic device import must not be added to upload private keys or trust client-supplied ownership. Reuse current authenticated message import and preserve acknowledgement/retry semantics.

Relationships are recorded per table in production-inventory.json and declared in `server/src/infrastructure/database/schema.generated.ts`. Runtime owners are routed through `AppContext` stores/Rows. The older root checkout has 120 direct-SQL files; production baseline already ports these paths through Rows. Mongo-native feature schemas live alongside their owning modules. Do not create parallel camelCase collections.

## Additional independent service found

`server/src/modules/federation/core/node.ts` implements an optional, separate federation registry node with `core.sqlite`: descriptors, domains, lifecycle status, finals, replication feed/cursors and audit. It is not instantiated by the deployed application API or present in the observed Compose services. Its private signing key remains device/server secure material. No record counts or deployed instance were found. If enabled in the Meldiq ecosystem, its persistent repository also needs a separate Atlas port/migration; do not advertise removal of every SQL code path while this implementation remains. The normal federation application domain already has Mongo Rows support.

Collision follow-up compared fields without printing values: account_passkeys differs only in last_used_at; platform_audit differs in its event fields/hash. Both source and destination are preserved in encrypted backups. The new migration default rejects conflicting contents and requires explicit reviewed archival before replacement.

## Filesystem and connection follow-up

No Firestore/Realtime Database or SQL ORM imports were found in web, admin or the inspected backend. File writes outside databases are binary uploads/photos, temporary federation attachment downloads, backend signing/sealing keys, and the development file mail transport. Production MAIL_TRANSPORT is SMTP, so the development .eml/.html spool is not an active competing database. Temporary files and backend encryption/signing keys retain their existing secure file storage; do not move device or server private keys into Redis.

A read-only driver connection confirmed TLS with certificate/hostname validation and a configured pool limit of 20. The dedicated user has readWrite on the application database and readWrite on one other database; the latter needs control-plane review/separation from the production runtime role. No broader administrative role was observed in connectionStatus. This does not prove the Atlas IP access list is restricted. Native browser automation timed out; minimum read-only Atlas control-plane access has been requested through a secure local file or authenticated session.

Preparation backups now also include the private deployment environment and reports sealing key, encrypted directly to age without printing values. Decryption was validated without displaying plaintext. Original host files are retained. These secrets remain outside Git and are not application database records.

## Release observed after initial inventory

An independent task deployed API 0.72.1 at commit 3c4d53a2 during this work. The migration candidate was integrated onto that commit, preserving native message retrieval metadata/indexes and the newer achievements/payment code. Those features use the same Atlas-authoritative native collections; their new fields must never be replaced from old SQL. Initial counts/backups remain preparation evidence, not final current counts. current-production-state.json captures only version/domain configuration, without credentials.

The final staged candidate also incorporates API 0.73.0 (1e99c4ae) leaderboard reads. They derive from existing Atlas-owned points/calls and community membership data; no additional authoritative store or new SQL table was found. The owner directed this task to finish staging while independent production releases continue. Counts and access review remain dated observations that must be refreshed for any future rollout.
