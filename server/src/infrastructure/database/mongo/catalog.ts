import { Binary, type IndexDescription } from "mongodb";
import type { DB } from "../db.js";

/**
 * How every SQLite table maps to a MongoDB collection (docs/MONGODB.md). Documents are the rows themselves (same field
 * names, so the code's row types fit both stores) plus `_id`, the table's primary key. Validators and indexes are derived
 * from the live SQLite schema, so the two can't drift apart: NOT NULL becomes a required field, column types become BSON
 * types, UNIQUE and plain indexes carry over (COLLATE NOCASE as a case-insensitive collation, `WHERE col IS NOT NULL` as
 * a partial index).
 */

/** Which part of the server owns a table; a domain moves to MongoDB as a whole (MONGODB_DOMAINS). */
export type TableDomain =
  | "accounts"
  | "preferences"
  | "integrations"
  | "identity"
  | "workspace"
  | "conversations"
  | "relay"
  | "calls"
  | "files"
  | "history"
  | "reports"
  | "relationships"
  | "federation"
  | "platform";

/**
 * Tables that never go to MongoDB, and why. They are either SQLite's own bookkeeping or short-lived security material
 * that is worthless after minutes and would only widen what a database copy exposes.
 */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  sqlite_sequence: "SQLite internal",
  schema_migrations: "SQLite migration bookkeeping (MongoDB has its own: orbit_meta)",
  auth_challenges: "sign-in nonces, valid for 2 minutes",
  pairing_requests: "device pairing in progress (10 minutes), carries sealed identity material for the new device",
  sessions: "v1 session token hashes (7 days); v1 apps sign in again by signature on their own",
  federation_nonces: "replay protection for signed server requests, minutes",
  // The Platform Admin Console (migration 046): sign-in material that is worthless after minutes or hours.
  platform_admin_challenges: "console passkey ceremonies in progress, 5 minutes",
  platform_admin_enrolments: "one-time console enrolment code hashes, 30 minutes",
  platform_admin_sessions: "console session token hashes, at most 12 hours",
  // Platform Admin 2.0 (migration 048): per-minute telemetry, worth little once its hourly rollup exists.
  presence_samples: "per-minute concurrency samples, 30 days (presence_hourly keeps the long view)",
  resource_samples: "per-minute resource samples, 7 days (resource_hourly keeps the long view)",
  quota_reservations: "quota reservations in flight, minutes",
  // Discord import (migration 056): a sign-in with Discord in progress, 10 minutes.
  discord_oauth_states: "Discord sign-in states in progress, 10 minutes",
};

export const TABLE_DOMAINS: Readonly<Record<string, TableDomain>> = {
  accounts: "accounts",
  account_sessions: "accounts",
  account_codes: "accounts",
  legacy_tickets: "accounts",
  // Recovery codes (round 6, docs/ACCOUNT_RECOVERY.md).
  account_recovery_codes: "accounts",
  account_recovery_tickets: "accounts",
  // Keys backed up under the password (2026-10-21, docs/KEY_BACKUP.md).
  account_key_backups: "accounts",
  account_key_unlocks: "accounts",
  // Passkeys (2026-10-23, docs/PASSKEYS.md); kept in SQLite in either mode.
  account_passkeys: "accounts",
  account_passkey_challenges: "accounts",
  // Account safety (API 0.46.0, docs/ACCOUNT_SAFETY.md); kept in SQLite in either mode, like passkeys.
  account_totp: "accounts",
  account_totp_backup: "accounts",
  account_email_changes: "accounts",
  account_warnings: "accounts",
  bug_reports: "accounts",
  nav_preferences: "preferences",
  // Apps and connected accounts (2026-10-19): removed with the community rebuild; the tables stay (src/retiredData.ts).
  integration_installs: "integrations",
  integration_accounts: "integrations",
  integration_credentials: "integrations",
  integration_oauth_states: "integrations",
  integration_subscriptions: "integrations",
  integration_deliveries: "integrations",
  integration_jobs: "integrations",
  integration_channel_events: "integrations",
  integration_policies: "integrations",
  integration_hooks: "integrations",
  users: "identity",
  devices: "identity",
  user_blocks: "identity",
  push_endpoints: "identity",
  fcm_tokens: "identity",
  // Reminders belong to the encryption identity, like saved items (round 6, docs/REMINDERS.md).
  reminders: "identity",
  reminder_occurrences: "identity",
  registration_invites: "identity",
  // Load-test provisioning counts (2026-10-23, docs/LOADTEST_PROVISIONING.md).
  loadtest_registrations: "identity",
  orgs: "workspace",
  org_members: "workspace",
  // Community rebuild (2026-10-21, docs/COMMUNITY_REBUILD_2026-10-21.md).
  channel_categories: "workspace",
  channel_overwrites: "workspace",
  org_bans: "workspace",
  join_applications: "workspace",
  community_migration_runs: "workspace",
  branches: "workspace",
  branch_members: "workspace",
  departments: "workspace",
  teams: "workspace",
  team_members: "workspace",
  invitations: "workspace",
  org_deletions: "workspace",
  // Branches and teams, workflows, documents, user groups, developer keys and the Unified Inbox: retired by the
  // community rebuild; their tables stay (src/retiredData.ts, src/communityMigration.ts).
  workflows: "workspace",
  workflow_runs: "workspace",
  documents: "workspace",
  document_members: "workspace",
  document_versions: "workspace",
  document_comments: "workspace",
  // Meetings, shown as community events (round 7, docs/WORKSPACE_C5.md).
  user_groups: "workspace",
  user_group_members: "workspace",
  meetings: "workspace",
  meeting_participants: "workspace",
  api_keys: "workspace",
  webhooks: "workspace",
  webhook_deliveries: "workspace",
  // Usage and per-workspace limits (round 7, docs/USAGE_AND_PLANS.md).
  usage_daily: "workspace",
  // Content-free daily product counts (Meldiq 2.0, docs/product/EXPERIMENTS.md).
  analytics_daily: "workspace",
  inbox_accounts: "workspace",
  inbox_queues: "workspace",
  inbox_contacts: "workspace",
  inbox_conversations: "workspace",
  inbox_messages: "workspace",
  inbox_events: "workspace",
  inbox_settings: "workspace",
  org_entitlements: "workspace",
  audit_log: "workspace",
  // Custom roles live with the rest of authorisation, which is synchronous on the message path (docs/WORKSPACE_ROLES.md).
  org_roles: "workspace",
  org_role_members: "workspace",
  conversations: "conversations",
  conversation_members: "conversations",
  mention_all_events: "conversations",
  delivery_queue: "relay",
  submitted_messages: "relay",
  // Calls belong to the calls module (Architecture 1.0): they move separately from the message relay.
  calls: "calls",
  call_participants: "calls",
  call_hands: "calls",
  attachments: "files",
  attachment_uploads: "files",
  abandoned_uploads: "files",
  pending_blob_deletes: "files",
  history_accounts: "history",
  history_items: "history",
  reports: "reports",
  // Batch B8b: onboarding questions and members' answers (configuration of a community, like roles).
  community_onboarding: "workspace",
  // Batch B9: a community's own emoji and stickers (their images are profile-photos blobs).
  community_expressions: "workspace",
  // Discord import (migration 056).
  discord_connections: "workspace",
  discord_imports: "workspace",
  discord_import_items: "workspace",
  onboarding_answers: "workspace",
  // Batch B6: connections, message requests and who may message you.
  connections: "relationships",
  dm_requests: "relationships",
  messaging_settings: "relationships",
  federation_blocks: "federation",
  federation_domains: "federation",
  federation_inbox: "federation",
  federation_outbox: "federation",
  federation_peers: "federation",
  // The Platform Admin Console (migration 046): grants, console passkeys, the append-only audit and incidents. Kept in
  // SQLite in every mode (copy and verify only, like identity).
  platform_admins: "platform",
  platform_admin_passkeys: "platform",
  platform_audit: "platform",
  platform_incidents: "platform",
  platform_incident_events: "platform",
  // Platform Admin 2.0 (migration 048): telemetry, quotas, AI providers, settings and alerts. Kept in SQLite in every mode.
  activity_daily: "platform",
  telemetry_epochs: "platform",
  traffic_user_daily: "platform",
  presence_hourly: "platform",
  resource_hourly: "platform",
  session_clients: "platform",
  quota_plans: "platform",
  quota_plan_members: "platform",
  quota_policies: "platform",
  quota_counters: "platform",
  quota_events: "platform",
  ai_providers: "platform",
  ai_models: "platform",
  ai_usage: "platform",
  platform_settings: "platform",
  alert_rules: "platform",
  alert_state: "platform",
  alert_deliveries: "platform",
  platform_restrictions: "platform",
  // AI Workforce (migration 049): model capabilities and routing, the catalog's state, communities' agents, jobs,
  // files' records, approvals and agent posts. Kept in SQLite in every mode, like the rest of the platform tables.
  ai_model_capabilities: "platform",
  ai_routing: "platform",
  ai_agent_templates: "platform",
  ai_tool_policies: "platform",
  ai_org_entitlements: "platform",
  ai_agent_installs: "platform",
  ai_agent_channels: "platform",
  ai_jobs: "platform",
  ai_job_events: "platform",
  ai_shared_messages: "platform",
  ai_triggers: "platform",
  ai_tasks: "platform",
  ai_task_events: "platform",
  ai_task_settings: "platform",
  ai_agent_identities: "platform",
  ai_channel_readers: "platform",
  ai_reader_choices: "platform",
  ai_channel_context: "platform",
  ai_reader_events: "platform",
  ai_system_checks: "platform",
  ai_files: "platform",
  ai_approvals: "platform",
  ai_channel_posts: "platform",
  // Billing (migration 061): the plan catalog, checkouts, subscriptions, invoices and provider events. Kept in SQLite in
  // every mode, like the rest of the platform tables.
  billing_plans: "platform",
  billing_plan_versions: "platform",
  billing_checkouts: "platform",
  billing_subscriptions: "platform",
  billing_subscription_history: "platform",
  billing_invoices: "platform",
  billing_provider_events: "platform",
  billing_webhook_rejections: "platform",
  billing_customers: "platform",
  billing_grants: "platform",
  billing_referral_codes: "platform",
  billing_referrals: "platform",
};

export interface ColumnSpec {
  name: string;
  /** SQLite declared type, upper case (INTEGER, TEXT, BLOB, REAL). */
  type: string;
  notNull: boolean;
}

export interface IndexSpec {
  name: string;
  columns: string[];
  unique: boolean;
  nocase: boolean;
  /** Columns of a `WHERE a IS NOT NULL [AND …]` partial index; null for a full index. */
  partialNotNull: string[] | null;
}

export interface TableSpec {
  name: string;
  domain: TableDomain;
  columns: ColumnSpec[];
  /** Primary key columns in key order; empty for a rowid table (then `_id` is the rowid). */
  primaryKey: string[];
  indexes: IndexSpec[];
}

/** Columns stored as JSON text in SQLite and as embedded documents in MongoDB. */
const JSON_COLUMNS: Readonly<Record<string, readonly string[]>> = { nav_preferences: ["doc"] };

/** Reads the live schema: every table that maps to a collection, in name order. Fails on a table nobody classified. */
export function describeTables(db: DB): TableSpec[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  const specs: TableSpec[] = [];
  for (const { name } of tables) {
    if (name in EXCLUDED_TABLES) continue;
    const domain = TABLE_DOMAINS[name];
    if (!domain) throw new Error(`Table ${name} has no MongoDB domain: classify it in src/infrastructure/database/mongo/catalog.ts`);
    const info = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string; notnull: number; pk: number }[];
    const columns = info.map((c) => ({ name: c.name, type: (c.type || "TEXT").toUpperCase(), notNull: c.notnull === 1 || c.pk > 0 }));
    const primaryKey = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    specs.push({ name, domain, columns, primaryKey, indexes: describeIndexes(db, name, columns) });
  }
  return specs;
}

function describeIndexes(db: DB, table: string, columns: ColumnSpec[]): IndexSpec[] {
  const list = db.prepare(`PRAGMA index_list("${table}")`).all() as { name: string; unique: number; origin: string; partial: number }[];
  const out: IndexSpec[] = [];
  for (const ix of list) {
    if (ix.origin === "pk") continue; // the primary key is `_id`
    const info = db.prepare(`PRAGMA index_xinfo("${ix.name}")`).all() as { name: string | null; coll: string; key: number }[];
    const keyCols = info.filter((c) => c.key === 1 && c.name);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(ix.name) as { sql: string | null } | undefined)?.sql ?? "";
    let partialNotNull: string[] | null = null;
    if (ix.partial) {
      const where = sql.slice(sql.toUpperCase().lastIndexOf(" WHERE ") + 7).trim();
      const parts = where.split(/\s+AND\s+/i).map((p) => p.match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?\s+IS\s+NOT\s+NULL$/i)?.[1] ?? null);
      if (parts.every((p) => p !== null)) partialNotNull = parts as string[];
      // Any other condition can't be expressed safely as a unique partial index: a person has to map it.
      else if (ix.unique) throw new Error(`Unique partial index ${ix.name} (${where}) needs a hand-written MongoDB mapping`);
    }
    out.push({
      name: ix.name,
      columns: keyCols.map((c) => c.name as string),
      unique: ix.unique === 1,
      nocase: keyCols.some((c) => c.coll.toUpperCase() === "NOCASE") || keyCols.some((c) => columnNocase(db, table, c.name as string)),
      partialNotNull,
    });
  }
  // Unique nullable columns: SQLite allows many NULLs, MongoDB would treat them as one value, so they become partial.
  return out.map((ix) => {
    if (!ix.unique || ix.partialNotNull) return ix;
    const nullable = ix.columns.filter((c) => !columns.find((col) => col.name === c)?.notNull);
    return nullable.length ? { ...ix, partialNotNull: nullable } : ix;
  });
}

/** A column declared COLLATE NOCASE (its implicit UNIQUE index reports BINARY otherwise). */
function columnNocase(db: DB, table: string, column: string): boolean {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
  const line = sql.split("\n").find((l) => new RegExp(`^\\s*"?${column}"?\\s`, "i").test(l)) ?? "";
  return /COLLATE\s+NOCASE/i.test(line);
}

function bsonTypes(c: ColumnSpec, table: string): string[] {
  if (JSON_COLUMNS[table]?.includes(c.name)) return ["object"];
  if (c.type.includes("INT")) return ["int", "long", "double"];
  if (c.type.includes("REAL") || c.type.includes("FLOA") || c.type.includes("DOUB")) return ["double", "int", "long"];
  if (c.type.includes("BLOB")) return ["binData"];
  return ["string"];
}

/** The collection's $jsonSchema: required NOT NULL fields with their BSON types; nullable fields may also be null. */
export function validatorFor(t: TableSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const c of t.columns) {
    const types = bsonTypes(c, t.name);
    properties[c.name] = { bsonType: c.notNull ? types : [...types, "null"] };
  }
  return {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", ...t.columns.filter((c) => c.notNull).map((c) => c.name)],
      properties,
    },
  };
}

const NOCASE_COLLATION = { locale: "en", strength: 2 } as const;

/** MongoDB indexes for a table: its SQLite indexes, plus one per primary-key column of a composite key (lookups by part). */
export function indexesFor(t: TableSpec): IndexDescription[] {
  const out: IndexDescription[] = t.indexes.map((ix) => {
    const d: IndexDescription = { key: Object.fromEntries(ix.columns.map((c) => [c, 1])), name: ix.name, unique: ix.unique };
    if (ix.nocase) d.collation = { ...NOCASE_COLLATION };
    if (ix.partialNotNull) {
      d.partialFilterExpression = Object.fromEntries(
        ix.partialNotNull.map((c) => [c, { $type: bsonTypes(t.columns.find((col) => col.name === c)!, t.name)[0] }]),
      );
    }
    return d;
  });
  if (t.primaryKey.length > 1) {
    for (const c of t.primaryKey) {
      if (!out.some((d) => Object.keys(d.key)[0] === c)) out.push({ key: { [c]: 1 }, name: `pk_${t.name}_${c}` });
    }
  }
  return out;
}

/** `_id` of a row: its single primary key value, an object of a composite key's columns in key order, or the rowid. */
export function docId(t: TableSpec, row: Record<string, unknown>): unknown {
  if (t.primaryKey.length === 0) return row.rowid;
  if (t.primaryKey.length === 1) return row[t.primaryKey[0]];
  return Object.fromEntries(t.primaryKey.map((c) => [c, row[c]]));
}

/** A SQLite row as a MongoDB document (JSON text columns parsed, everything else as is). */
export function toDocument(t: TableSpec, row: Record<string, unknown>): Record<string, unknown> {
  const doc: Record<string, unknown> = { _id: docId(t, row) };
  for (const c of t.columns) {
    const v = row[c.name];
    doc[c.name] = JSON_COLUMNS[t.name]?.includes(c.name) && typeof v === "string" ? JSON.parse(v) : (v ?? null);
  }
  return doc;
}

/** A MongoDB document back as a SQLite row (rollback and restore). */
export function toRow(t: TableSpec, doc: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const c of t.columns) {
    let v = doc[c.name] ?? null;
    if (JSON_COLUMNS[t.name]?.includes(c.name) && v !== null && typeof v === "object") v = JSON.stringify(v);
    else if (v instanceof Binary) v = Buffer.from(v.buffer);
    row[c.name] = v;
  }
  if (t.primaryKey.length === 0) row.rowid = doc._id;
  return row;
}
