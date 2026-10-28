import type { Rows } from "../../infrastructure/database/rows/index.js";
import type { TrialConfig } from "./config.js";

/**
 * The trial and invite program as it applies now (docs/BILLING.md › Running trials from the console). Operators set it
 * in the Platform Admin Console; until they first do, the server's environment (BILLING_TRIAL_*, config.ts) decides.
 * Reading it is one in-memory row lookup, so every request sees a change at once, with no restart.
 */
export interface ProgramSettings {
  enabled: boolean;
  /** Trials and invite links count from here; accounts created earlier get their trial from this moment. */
  startsAt: number | null;
  planKey: string;
  days: number;
  referralDays: number;
  referralCapDays: number;
  claimWindowDays: number;
}

export interface ProgramState {
  /** Where the program comes from: the console's saved settings, or the environment while none are saved. */
  source: "console" | "environment";
  settings: ProgramSettings;
  updatedBy: string | null;
  updatedAt: number | null;
}

interface ProgramRow {
  enabled: number;
  starts_at: number | null;
  plan_key: string;
  days: number;
  referral_days: number;
  referral_cap_days: number;
  claim_window_days: number;
  updated_by: string;
  updated_at: number;
}

/** The terms a console form starts from when neither the console nor the environment has set the program. */
export const PROGRAM_DEFAULTS: Omit<ProgramSettings, "enabled" | "startsAt"> = { planKey: "plus", days: 14, referralDays: 30, referralCapDays: 90, claimWindowDays: 7 };

export function settingsOfEnvironment(env: TrialConfig | null): ProgramSettings {
  return env ? { enabled: true, ...env } : { enabled: false, startsAt: null, ...PROGRAM_DEFAULTS };
}

export class BillingProgram {
  constructor(
    private readonly rows: Rows,
    readonly fromEnvironment: TrialConfig | null,
  ) {}

  state(): ProgramState {
    const row = this.rows.get<ProgramRow>("billing_program", { id: 1 });
    if (!row) return { source: "environment", settings: settingsOfEnvironment(this.fromEnvironment), updatedBy: null, updatedAt: null };
    return {
      source: "console",
      settings: {
        enabled: row.enabled === 1,
        startsAt: row.starts_at,
        planKey: row.plan_key,
        days: row.days,
        referralDays: row.referral_days,
        referralCapDays: row.referral_cap_days,
        claimWindowDays: row.claim_window_days,
      },
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  }

  /** The program the grants follow now (null: off, so no new trials and invite links don't count). */
  current(): TrialConfig | null {
    const { settings: s } = this.state();
    if (!s.enabled || s.startsAt === null) return null;
    return { startsAt: s.startsAt, planKey: s.planKey, days: s.days, referralDays: s.referralDays, referralCapDays: s.referralCapDays, claimWindowDays: s.claimWindowDays };
  }

  /** Saves the console's settings (validated by the route's schema). Returns the state before, for the audit. */
  async save(s: ProgramSettings, actor: string, t: number): Promise<ProgramState> {
    const before = this.state();
    const row = {
      id: 1,
      enabled: s.enabled ? 1 : 0,
      starts_at: s.startsAt,
      plan_key: s.planKey,
      days: s.days,
      referral_days: s.referralDays,
      referral_cap_days: s.referralCapDays,
      claim_window_days: s.claimWindowDays,
      updated_by: actor,
      updated_at: t,
    };
    await this.rows.write((w) => w.upsert("billing_program", row, "replace"));
    return before;
  }

  /** Forgets the console's settings, so the environment decides again. Returns the state before. */
  async useEnvironment(): Promise<ProgramState> {
    const before = this.state();
    await this.rows.write((w) => w.delete("billing_program", { id: 1 }));
    return before;
  }
}
