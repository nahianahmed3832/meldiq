import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { can, PERMISSIONS, PLATFORM_ROLES, permissionsOf, SENSITIVE } from "../src/modules/platformAdmin/permissions.js";

/**
 * The console's roles (meldiq_central_admin/docs/ARCHITECTURE_PROPOSAL.md §3.6) and what its code may reach (§6–7).
 * The expected table is written out here on purpose: changing a role's powers means changing this test too.
 */
const EXPECTED: Record<string, string[]> = {
  super_admin: [...PERMISSIONS],
  operations_admin: [
    "overview.view",
    "users.view",
    "users.sessions.revoke",
    "orgs.view",
    "health.view",
    "connectors.view",
    "connectors.check",
    "incidents.view",
    "incidents.manage",
    "analytics.view",
    "presence.view",
    "devices.view",
    "resources.view",
    "quotas.view",
    "quotas.edit",
    "settings.view",
    "alerts.manage",
    "exports.create",
  ],
  support_admin: [
    "overview.view",
    "users.view",
    "users.view_email",
    "users.suspend",
    "users.restore",
    "users.sessions.revoke",
    "orgs.view",
    "entitlements.view",
    "health.view",
    "connectors.view",
    "incidents.view",
    "incidents.manage",
    "analytics.view",
    "presence.view",
    "devices.view",
    "devices.revoke",
    "users.recovery",
    "quotas.view",
    "billing.view",
  ],
  billing_admin: [
    "overview.view",
    "orgs.view",
    "entitlements.view",
    "entitlements.edit",
    "analytics.view",
    "resources.view",
    "quotas.view",
    "quotas.edit",
    "settings.view",
    "billing.view",
    "billing.manage",
    "billing.events.replay",
  ],
  auditor: [
    "overview.view",
    "users.view",
    "orgs.view",
    "entitlements.view",
    "health.view",
    "connectors.view",
    "incidents.view",
    "audit.view",
    "admins.view",
    "analytics.view",
    "presence.view",
    "devices.view",
    "resources.view",
    "quotas.view",
    "settings.view",
    "exports.create",
    "billing.view",
  ],
};

describe("platform roles", () => {
  it("grant exactly the documented permissions", () => {
    for (const role of PLATFORM_ROLES) expect(new Set(permissionsOf(role)), role).toEqual(new Set(EXPECTED[role]));
  });

  it("deny anything unknown", () => {
    expect(can("super_admin", "messages.read" as never)).toBe(false);
    expect(can("owner" as never, "overview.view")).toBe(false);
  });

  it("keep audit and admin management away from operations, support and billing", () => {
    for (const role of ["operations_admin", "support_admin", "billing_admin"] as const) {
      expect(can(role, "audit.view")).toBe(false);
      expect(can(role, "admins.manage")).toBe(false);
    }
    for (const p of SENSITIVE) expect(can("auditor", p)).toBe(false);
  });

  it("keep credentials, deletion, settings and membership changes to super admins", () => {
    for (const p of ["users.delete", "settings.edit", "orgs.members.manage", "admins.manage"] as const) {
      for (const role of PLATFORM_ROLES) expect(can(role, p), `${role} ${p}`).toBe(role === "super_admin");
    }
  });

  it("don't let billing suspend people, or support see billing controls and infrastructure costs", () => {
    expect(can("billing_admin", "users.suspend")).toBe(false);
    expect(can("billing_admin", "settings.edit")).toBe(false);
    expect(can("support_admin", "entitlements.edit")).toBe(false);
    expect(can("support_admin", "quotas.edit")).toBe(false);
    expect(can("support_admin", "resources.view")).toBe(false);
    expect(can("support_admin", "audit.view")).toBe(false);
  });
});

describe("the console's code", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, "..", "src", "modules", "platformAdmin");
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), "utf8") }));

  it("imports no messaging, history, file, report or key code", () => {
    // Platform Admin 2.0 adds metadata-only modules: telemetry (counts and client kinds), quotas, AI provider settings,
    // and wake-up registration state (never the token). Billing holds plans, subscriptions and provider references only.
    const allowed = /^\.\.\/(accounts|administration|auth|organizations|telemetry|quotas|ai|notifications|billing)\/index\.js$|^\.\/|^\.\.\/\.\.\/(app|shared|infrastructure)\//;
    for (const { file, text } of sources) {
      for (const [, names, spec] of text.matchAll(/import\s+([^;]*?)\s+from\s+"([^"]+)"/gs)) {
        if (!spec.startsWith(".")) continue;
        // From messaging, only the channel count of a community (a number).
        if (spec === "../messaging/index.js") {
          expect(names.replace(/\s/g, ""), `${file} imports ${names} from messaging`).toBe("{channelCounts}");
          continue;
        }
        // From AI Workforce (docs/AI_WORKFORCE.md §8): catalog definitions, policy schemas, tool facts, the media
        // engine's state, and the console view's type. Runtime access goes through ctx.workforce.console only.
        if (spec === "../workforce/index.js") {
          const allowedNames = new Set(["AGENTS", "agentSummary", "Entitlement", "JobMeta", "JobState", "jobStateCounts", "mediaEngine", "TemplatePolicy", "TemplateStatus", "TOOL_INFO", "TOOL_KEYS", "ToolMode", "WorkforceConsoleView"]);
          for (const n of names.replace(/[{}\s]/g, "").split(",").filter(Boolean)) expect(allowedNames.has(n.replace(/^type/, "")), `${file} imports ${n} from workforce`).toBe(true);
          continue;
        }
        expect(allowed.test(spec), `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("never touches message content, history, queued envelopes, files, reports or key backups", () => {
    const forbidden = /ctx\.(history|relay|files|reports|reportSealer|blobs)\b|ctx\.workforce\.(?!console\b)|\b(history_items|delivery_queue|submitted_messages|attachments|key_backups|reports|ai_files|ai_channel_posts)\b/;
    for (const { file, text } of sources) expect(forbidden.test(text), file).toBe(false);
  });
});
