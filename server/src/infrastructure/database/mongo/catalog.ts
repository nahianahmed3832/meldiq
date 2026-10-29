import { Binary, type IndexDescription } from "mongodb";
import type { DB } from "../db.js";
import { SCHEMA } from "../schema.generated.js";

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
  | "platform"
  | "billing"
  | "safety"
  | "ephemeral";

/**
 * Tables that never go to MongoDB, and why. They are either SQLite's own bookkeeping or short-lived security material
 * that is worthless after minutes and would only widen what a database copy exposes.
 */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  sqlite_sequence: "SQLite internal",
  schema_migrations: "SQLite migration bookkeeping (MongoDB has its own: orbit_meta)",
};

/**
 * Short-lived tables (the "ephemeral" domain, 2026-10-28): sign-in material and samples that matter for minutes, hours or
 * days. They were never copied while their home was SQLite (a copy would only widen what a database copy exposes); with
 * everything moving to MongoDB they live there like the rest, and are copied at the switch so nobody is signed out.
 */
export const EPHEMERAL_TABLES: Readonly<Record<string, string>> = {
  auth_challenges: "sign-in nonces, valid for 2 minutes",
  pairing_requests: "device pairing in progress (10 minutes), carries sealed identity material for the new device",
  sessions: "v1 session token hashes (7 days)",
  federation_nonces: "replay protection for signed server requests, minutes",
  // The Platform Admin Console (migration 046): sign-in material that is worthless after minutes or hours.
  platform_admin_challenges: "console passkey ceremonies in progress, 5 minutes",
  platform_admin_enrolments: "one-time console enrolment code hashes, 30 minutes",
  platform_admin_sessions: "console session token hashes, at most 12 hours",
  // Platform Admin 2.0 (migration 048): per-minute telemetry, worth little once its hourly rollup exists.
  presence_samples: "per-minute concurrency samples, 30 days (presence_hourly keeps the long view)",
  resource_samples: "per-minute resource samples, 7 days (resource_hourly keeps the long view)",
  // Discord import (migration 056): a sign-in with Discord in progress, 10 minutes.
  discord_oauth_states: "Discord sign-in states in progress, 10 minutes",
};

export const TABLE_DOMAINS: Readonly<Record<string, TableDomain>> = {
  ...(Object.fromEntries(Object.keys(EPHEMERAL_TABLES).map((t) => [t, "ephemeral"])) as Record<string, TableDomain>),
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
  // Passkeys (2026-10-23, docs/PASSKEYS.md) and account safety (API 0.46.0, docs/ACCOUNT_SAFETY.md): the "safety" domain,
  // apart from "accounts" because they were written to SQLite while the accounts were already in MongoDB.
  account_passkeys: "safety",
  account_passkey_challenges: "safety",
  account_totp: "safety",
  account_totp_backup: "safety",
  account_email_changes: "safety",
  account_warnings: "safety",
  bug_reports: "safety",
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
  message_events: "history",
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
  // The Platform Admin Console (migration 046): grants, console passkeys, the append-only audit and incidents.
  platform_admins: "platform",
  platform_admin_passkeys: "platform",
  platform_audit: "platform",
  platform_incidents: "platform",
  platform_incident_events: "platform",
  // Platform Admin 2.0 (migration 048): telemetry, quotas, AI providers, settings and alerts.
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
  // Short-lived, but a reservation and the counters it holds change in one unit, so they live together.
  quota_reservations: "platform",
  ai_providers: "platform",
  ai_models: "platform",
  ai_usage: "platform",
  platform_settings: "platform",
  operator_accounts: "platform",
  alert_rules: "platform",
  alert_state: "platform",
  alert_deliveries: "platform",
  platform_restrictions: "platform",
  // AI Workforce (migration 049): model capabilities and routing, the catalog's state, communities' agents, jobs,
  // files' records, approvals and agent posts.
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
  // Billing (migration 061): the plan catalog, checkouts, subscriptions, invoices and provider events.
  billing_plans: "billing",
  billing_plan_versions: "billing",
  billing_checkouts: "billing",
  billing_subscriptions: "billing",
  billing_subscription_history: "billing",
  billing_invoices: "billing",
  billing_provider_events: "billing",
  billing_webhook_rejections: "billing",
  billing_customers: "billing",
  billing_grants: "billing",
  billing_referral_codes: "billing",
  billing_referrals: "billing",
  // Meldiq Mojo's perks (API 0.54.0, docs/MOJO.md).
  spark_assignments: "billing",
  mojo_gifts: "billing",
  billing_program: "billing",
  mojo_controls: "billing",
  billing_grant_notes: "billing",
  mojo_profile: "billing",
  // Google Play purchases (API 0.55.0, docs/MOJO_ANDROID.md).
  billing_play_purchases: "billing",
};

export interface ColumnSpec {
  name: string;
  /** SQLite declared type, upper case (INTEGER, TEXT, BLOB, REAL). */
  type: string;
  notNull: boolean;
  /** The column's literal DEFAULT (undefined: none; an expression default is kept as { expression }). */
  default?: string | number | null | { expression: string };
  /** Declared COLLATE NOCASE: equality and uniqueness ignore ASCII case. */
  nocase?: boolean;
}

/** A foreign key: [columns] of this table reference [references] of [table]. */
export interface ForeignKeySpec {
  columns: string[];
  table: string;
  references: string[];
  onDelete: "CASCADE" | "SET NULL" | "SET DEFAULT" | "RESTRICT" | "NO ACTION";
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
  foreignKeys: ForeignKeySpec[];
  /** INTEGER PRIMARY KEY AUTOINCREMENT: ids are assigned in increasing order and never reused. */
  autoincrement: boolean;
}

/** A PRAGMA table_info default as a value: a number, a quoted string, NULL, or an expression kept as text. */
function parseDefault(raw: string | null): ColumnSpec["default"] {
  if (raw === null) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const quoted = raw.match(/^'([\s\S]*)'$/);
  if (quoted) return quoted[1].replaceAll("''", "'");
  if (/^NULL$/i.test(raw)) return null;
  return { expression: raw };
}

/** Columns stored as JSON text in SQLite and as embedded documents in MongoDB. */
const JSON_COLUMNS: Readonly<Record<string, readonly string[]>> = { nav_preferences: ["doc"] };

/** A table as the migrations create it, before its domain is assigned (the checked-in schema's entries). */
export type TableShape = Omit<TableSpec, "domain">;

let specs: TableSpec[] | null = null;

/**
 * Every table the migrations create, from the checked-in schema (src/infrastructure/database/schema.generated.ts,
 * written by `npm run schema`), with its domain: what the server and the rows layer run on, no database needed.
 */
export function tableSpecs(): TableSpec[] {
  specs ??= SCHEMA.map((t) => {
    const domain = TABLE_DOMAINS[t.name];
    if (!domain) throw new Error(`Table ${t.name} has no MongoDB domain: classify it in src/infrastructure/database/mongo/catalog.ts`);
    return { ...t, domain };
  });
  return specs;
}

/** The checked-in schema file's text for [tables] (scripts/schema.ts writes it; test/schema.test.ts compares it). */
export function schemaSource(tables: readonly TableSpec[]): string {
  // One line per column, index and foreign key: small, and a migration's change reads clearly in a diff.
  const list = (items: readonly unknown[]) => (items.length ? `[\n${items.map((i) => `      ${JSON.stringify(i)},`).join("\n")}\n    ]` : "[]");
  const table = (t: TableSpec) =>
    [
      "  {",
      `    name: ${JSON.stringify(t.name)},`,
      `    columns: ${list(t.columns)},`,
      `    primaryKey: ${JSON.stringify(t.primaryKey)},`,
      `    indexes: ${list(t.indexes)},`,
      `    foreignKeys: ${list(t.foreignKeys)},`,
      `    autoincrement: ${t.autoincrement},`,
      "  },",
    ].join("\n");
  return [
    "// Generated by `npm run schema` (scripts/schema.ts) from migrations/: do not edit. Add a migration and run it again.",
    'import type { TableShape } from "./mongo/catalog.js";',
    "",
    "export const SCHEMA: readonly TableShape[] = [",
    ...tables.map(table),
    "];",
    "",
  ].join("\n");
}

/**
 * Reads the schema of a SQLite database: every table that maps to a collection, in name order. Fails on a table nobody
 * classified. For tools that read a SQLite file (migration to MongoDB, snapshots) and for the schema's generator; the
 * server itself runs on [tableSpecs].
 */
export function describeTables(db: DB): TableSpec[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  const specs: TableSpec[] = [];
  for (const { name } of tables) {
    if (name in EXCLUDED_TABLES) continue;
    const domain = TABLE_DOMAINS[name];
    if (!domain) throw new Error(`Table ${name} has no MongoDB domain: classify it in src/infrastructure/database/mongo/catalog.ts`);
    const info = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string; notnull: number; pk: number; dflt_value: string | null }[];
    const columns: ColumnSpec[] = info.map((c) => ({
      name: c.name,
      type: (c.type || "TEXT").toUpperCase(),
      notNull: c.notnull === 1 || c.pk > 0,
      ...(c.dflt_value !== null ? { default: parseDefault(c.dflt_value) } : {}),
      ...(columnNocase(db, name, c.name) ? { nocase: true } : {}),
    }));
    const primaryKey = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql;
    specs.push({ name, domain, columns, primaryKey, indexes: describeIndexes(db, name, columns), foreignKeys: describeForeignKeys(db, name), autoincrement: /AUTOINCREMENT/i.test(sql) });
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

function describeForeignKeys(db: DB, table: string): ForeignKeySpec[] {
  const rows = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { id: number; seq: number; table: string; from: string; to: string; on_delete: string }[];
  const byId = new Map<number, ForeignKeySpec>();
  for (const r of [...rows].sort((a, b) => a.id - b.id || a.seq - b.seq)) {
    const fk = byId.get(r.id) ?? { columns: [], table: r.table, references: [], onDelete: r.on_delete as ForeignKeySpec["onDelete"] };
    fk.columns.push(r.from);
    fk.references.push(r.to);
    byId.set(r.id, fk);
  }
  return [...byId.values()];
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
