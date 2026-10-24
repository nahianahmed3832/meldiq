import { z } from "zod/v4";
import type { DB } from "../../infrastructure/database/db.js";
import { ApiError } from "../../shared/errors.js";

/**
 * Runtime platform settings changed from the console (docs/PLATFORM_SETTINGS.md). Only settings that really change
 * what the server does are here, each with its schema and default; every change is audited with its before and after
 * value by the route that makes it. Secrets never live here (AI keys are encrypted in ai_providers; everything else
 * stays in the server's environment).
 */
const COST = z.strictObject({
  /** Micro-USD (millionths of a dollar). */
  amountMicro: z.number().int().min(0).max(1e15).nullable(),
  /** Where the figure comes from: the provider's invoice or price page, and when it was read. */
  source: z.string().trim().max(200),
});

export const SETTINGS = {
  "ai.enabled": {
    label: "AI requests allowed",
    description: "The global AI kill switch. Off: the gateway refuses every AI request before any provider is called. Messaging, calls and sign-in are unaffected.",
    schema: z.boolean(),
    default: false,
  },
  // AI Workforce (docs/AI_WORKFORCE.md §5 and §9). They change what the job engine does at once, not only the console.
  "ai.workforce.enabled": {
    label: "AI Workforce available",
    description: "Off: communities can't install or ask agents, and no job starts. Jobs already running finish their current step and stop.",
    schema: z.boolean(),
    default: false,
  },
  "ai.workforce.channel_reading": {
    label: "AI agents may read channels",
    description:
      "Off: no agent reads any channel, and switching a reader on is refused; readers already on stop reading at once (their channels' managers switch them off to erase what they kept). On: a channel's managers may let an agent read new messages there, with a notice to every member and each member's own opt-out. Those messages are then readable by the server and the AI provider.",
    schema: z.boolean(),
    default: false,
  },
  "ai.workforce.paused": {
    label: "New AI jobs paused",
    description: "An emergency pause: no new job is accepted or started. Running steps finish; jobs waiting in the queue stay there until it's lifted.",
    schema: z.boolean(),
    default: false,
  },
  "ai.workforce.max_concurrency": {
    label: "AI jobs running at once",
    description: "How many agent jobs this server works on at the same time. Lowering it takes effect for the next job; running ones aren't stopped.",
    schema: z.number().int().min(0).max(16),
    default: 2,
  },
  "ai.workforce.approval_floor": {
    label: "Approval policy",
    description: "standard: each community chooses review or automatic for internal work. strict: every agent works in review mode, whatever its community chose.",
    schema: z.enum(["standard", "strict"]),
    default: "standard" as "standard" | "strict",
  },
  "analytics.excluded_users": {
    label: "People left out of analytics",
    description: "User ids of internal and test accounts. Load-test accounts are always left out. Applies to past figures too.",
    schema: z.array(z.string().regex(/^[A-Za-z0-9_-]{4,64}$/)).max(1000),
    default: [] as string[],
  },
  "analytics.exclude_admins": {
    label: "Leave console admins out of analytics",
    description: "Leaves out the people who hold a console role, so operators don't count as users.",
    schema: z.boolean(),
    default: true,
  },
  "alerts.email": {
    label: "Email alerts to operators",
    description: "When an alert rule opens an incident, email the super and operations admins (through the server's mail transport). Off: incidents are only shown in the console.",
    schema: z.boolean(),
    default: false,
  },
  "costs.server_monthly": {
    label: "Server cost per month",
    description: "What the hosting plan costs per month, from the provider's invoice. Used only for estimates in the console.",
    schema: COST,
    default: { amountMicro: null, source: "" },
  },
  "costs.transfer_allowance_bytes": {
    label: "Monthly transfer included",
    description: "The data transfer the hosting plan includes per month, in bytes, from the plan's terms (null: unknown).",
    schema: z.strictObject({ bytes: z.number().int().min(0).nullable(), source: z.string().trim().max(200) }),
    default: { bytes: null, source: "" },
  },
  "costs.storage_per_gb_month": {
    label: "File storage price per GB-month",
    description: "The object storage price per GB stored per month, from the provider's price page. Estimates only: the provider's bill is the real figure.",
    schema: COST,
    default: { amountMicro: null, source: "" },
  },
  "costs.egress_per_gb": {
    label: "File download price per GB",
    description: "The object storage's price per GB transferred out to the internet, from the provider's price page.",
    schema: COST,
    default: { amountMicro: null, source: "" },
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;

export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(SETTINGS, k);

/** The current value of [key] (its default when never set, or when a stored value no longer fits its schema). */
export function platformSetting<K extends SettingKey>(db: DB, key: K): SettingValue<K> {
  const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return SETTINGS[key].default as SettingValue<K>;
  const parsed = SETTINGS[key].schema.safeParse(JSON.parse(row.value));
  return (parsed.success ? parsed.data : SETTINGS[key].default) as SettingValue<K>;
}

export function settingMeta(db: DB, key: SettingKey): { updatedBy: string | null; updatedAt: number | null } {
  const row = db.prepare("SELECT updated_by, updated_at FROM platform_settings WHERE key = ?").get(key) as { updated_by: string; updated_at: number } | undefined;
  return { updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null };
}

/** Validates and stores [value]; returns the previous value (for the audit's before/after). */
export function writeSetting(db: DB, key: SettingKey, value: unknown, actor: string, at: number): { before: unknown; after: unknown } {
  const parsed = SETTINGS[key].schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_policy", `${SETTINGS[key].label}: ${parsed.error.issues[0]?.message ?? "not a valid value"}`);
  const before = platformSetting(db, key);
  db.prepare("INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(
    key,
    JSON.stringify(parsed.data),
    actor,
    at,
  );
  return { before, after: parsed.data };
}
