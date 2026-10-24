import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architecture 1.0 dependency rules (docs/architecture/ARCHITECTURE_1_0_PLAN.md §3.2), checked on every import in
 * src/:
 *
 * - shared/ imports only shared/;
 * - infrastructure/ imports only shared/ and infrastructure/;
 * - a module imports shared/, infrastructure/, app/, its own files, and another module only through that module's
 *   index.ts;
 * - app/ and the entrypoints (index.ts, admin.ts, seed.ts, core/index.ts) may import anything.
 *
 * Imports that broke a rule when the layout was introduced are listed in architecture_boundaries.allowlist.json.
 * The list may only shrink: a new violation fails, and so does a listed one that no longer exists (remove it).
 * Regenerate after removing violations with MELDIQ_WRITE_BOUNDARY_ALLOWLIST=1.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..", "src");
const ALLOWLIST = path.join(here, "architecture_boundaries.allowlist.json");
const SPEC = /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\bimport\s+["'])(\.{1,2}\/[^"']+)["']/g;

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return p.endsWith(".ts") ? [p] : [];
  });

type Area = { kind: "shared" | "infrastructure" | "app" | "entry" } | { kind: "module"; name: string };

function areaOf(rel: string): Area {
  const [top, second] = rel.split("/");
  if (top === "shared" || top === "infrastructure" || top === "app") return { kind: top };
  if (top === "modules" && second) return { kind: "module", name: second };
  return { kind: "entry" };
}

function violates(from: string, to: string): boolean {
  const a = areaOf(from);
  const b = areaOf(to);
  switch (a.kind) {
    case "entry":
    case "app":
      return false;
    case "shared":
      return b.kind !== "shared";
    case "infrastructure":
      return b.kind !== "shared" && b.kind !== "infrastructure";
    case "module":
      if (b.kind !== "module" || b.name === a.name) return b.kind === "entry";
      return to !== `modules/${b.name}/index.ts`;
  }
}

function currentViolations(): string[] {
  const found = new Set<string>();
  for (const file of walk(SRC)) {
    const from = path.relative(SRC, file).split(path.sep).join("/");
    for (const m of fs.readFileSync(file, "utf8").matchAll(SPEC)) {
      const target = path.resolve(path.dirname(file), m[1]!).replace(/\.js$/, ".ts");
      if (!target.startsWith(SRC + path.sep)) continue;
      const to = path.relative(SRC, target).split(path.sep).join("/");
      if (violates(from, to)) found.add(`${from} -> ${to}`);
    }
  }
  return [...found].sort();
}

/**
 * Which module owns each table (and the MongoDB collection of the same name), from the plan's §5.1. Tables of retired
 * modules belong to administration, which keeps them for `admin retired-data`.
 */
const TABLE_OWNERS: Readonly<Record<string, string>> = {
  ...owned("auth", "auth_challenges sessions pairing_requests"),
  ...owned(
    "accounts",
    "accounts account_sessions account_codes legacy_tickets account_recovery_codes account_recovery_tickets account_passkeys account_passkey_challenges " +
      "account_key_backups account_key_unlocks users devices user_blocks nav_preferences connections dm_requests " +
      "messaging_settings reminders reminder_occurrences registration_invites loadtest_registrations",
  ),
  ...owned(
    "organizations",
    "orgs org_members org_roles org_role_members channel_categories channel_overwrites org_bans invitations audit_log " +
      "join_applications community_expressions community_onboarding onboarding_answers community_migration_runs " +
      "org_deletions reports branches branch_members departments teams team_members",
  ),
  ...owned(
    "messaging",
    "conversations conversation_members mention_all_events delivery_queue submitted_messages history_accounts history_items",
  ),
  ...owned("files", "attachments attachment_uploads abandoned_uploads pending_blob_deletes"),
  ...owned("calls", "calls call_participants call_hands meetings meeting_participants"),
  ...owned("notifications", "push_endpoints fcm_tokens"),
  ...owned(
    "administration",
    "usage_daily analytics_daily org_entitlements api_keys user_groups user_group_members webhooks webhook_deliveries " +
      "workflows workflow_runs documents document_members document_versions document_comments inbox_accounts " +
      "inbox_contacts inbox_conversations inbox_events inbox_messages inbox_queues inbox_settings integration_accounts " +
      "integration_channel_events integration_credentials integration_deliveries integration_hooks integration_installs " +
      "integration_jobs integration_oauth_states integration_policies integration_subscriptions",
  ),
  ...owned(
    "federation",
    "federation_blocks federation_domains federation_inbox federation_nonces federation_outbox federation_peers",
  ),
  // The Platform Admin Console (migration 046).
  ...owned(
    "platformAdmin",
    "platform_admins platform_admin_passkeys platform_admin_enrolments platform_admin_challenges platform_admin_sessions " +
      "platform_audit platform_incidents platform_incident_events platform_settings alert_rules alert_state alert_deliveries " +
      "platform_restrictions",
  ),
  // Platform Admin 2.0 (migration 048).
  ...owned(
    "telemetry",
    "activity_daily telemetry_epochs traffic_user_daily presence_samples presence_hourly resource_samples resource_hourly session_clients",
  ),
  ...owned("quotas", "quota_plans quota_plan_members quota_policies quota_counters quota_reservations quota_events"),
  ...owned("ai", "ai_providers ai_models ai_usage ai_model_capabilities ai_routing"),
  // AI Workforce 1.0 (migration 049).
  ...owned(
    "workforce",
    "ai_agent_templates ai_tool_policies ai_org_entitlements ai_agent_installs ai_agent_channels ai_jobs ai_job_events ai_files " +
      "ai_approvals ai_channel_posts ai_shared_messages ai_triggers ai_tasks ai_task_events ai_task_settings",
  ),
};

function owned(module: string, tables: string): Record<string, string> {
  return Object.fromEntries(tables.split(" ").map((t) => [t, module]));
}

/** SQL statements are written with upper-case keywords; MongoDB collections are opened by name. */
const TABLE_REF = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+"?([a-z_]+)"?|\bcollection(?:<[^>]*>)?\(\s*["'`]([a-z_]+)["'`]/g;

/** Where any table may be touched: wiring, entrypoints, and the database tools that copy every table. */
function mayTouchAnyTable(rel: string): boolean {
  const area = areaOf(rel);
  return area.kind === "app" || area.kind === "entry" || rel.startsWith("infrastructure/database/");
}

function currentTableViolations(): string[] {
  const found = new Set<string>();
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    if (mayTouchAnyTable(rel)) continue;
    const area = areaOf(rel);
    const mine = area.kind === "module" ? area.name : null;
    for (const m of fs.readFileSync(file, "utf8").matchAll(TABLE_REF)) {
      const table = m[1] ?? m[2]!;
      const owner = TABLE_OWNERS[table];
      if (owner && owner !== mine) found.add(`${rel} -> ${table}`);
    }
  }
  return [...found].sort();
}

const TABLE_ALLOWLIST = path.join(here, "architecture_tables.allowlist.json");

function checkAgainst(file: string, now: string[], what: string): void {
  if (process.env.MELDIQ_WRITE_BOUNDARY_ALLOWLIST === "1") fs.writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
  const allowed = new Set<string>(JSON.parse(fs.readFileSync(file, "utf8")) as string[]);
  const added = now.filter((v) => !allowed.has(v));
  const gone = [...allowed].filter((v) => !now.includes(v));
  expect(added, `new ${what} that break the ownership rules`).toEqual([]);
  expect(gone, `allowlisted ${what} that no longer exist: remove them from the allowlist`).toEqual([]);
}

describe("architecture boundaries", () => {
  it("allows only the listed exceptions to the dependency rules", () => {
    checkAgainst(ALLOWLIST, currentViolations(), "imports");
  });

  it("lets a module touch another module's tables only where already listed", () => {
    checkAgainst(TABLE_ALLOWLIST, currentTableViolations(), "table accesses");
  });

  it("knows an owner for every table the migrations create", () => {
    const migrations = path.resolve(here, "..", "migrations");
    const created = fs
      .readdirSync(migrations)
      .flatMap((f) => [...fs.readFileSync(path.join(migrations, f), "utf8").matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)])
      .map((m) => m[1]!);
    expect(created.filter((t) => !TABLE_OWNERS[t])).toEqual([]);
  });

  it("keeps the layout's top-level folders", () => {
    const top = fs.readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(top).toEqual(["app", "core", "infrastructure", "modules", "shared"]);
  });
});
