import type { Rows } from "../../infrastructure/database/rows/index.js";
import { ApiError } from "../../shared/errors.js";
import type { MojoEnforce } from "./mojo.js";
import { CATALOG_VERSION, GB, PLAN_KEYS, PLAN_PERKS, type PlanKey, type PlanPerks, SCREEN_PRESETS, type ScreenPresetId, SPARK_LEVELS, type SparkLevel } from "./perks.js";

/**
 * Meldiq Mojo run from the Platform Admin Console (docs/MOJO.md › Running Mojo from the console): whether plan limits
 * are enforced (overriding MOJO_ENFORCE), and operators' changes to the numbers in perks.ts: the numeric limits and
 * each plan's screen-share ceiling (one preset, which covers every smaller one). Names and badges can't change. The
 * list price changes only with the plan's price (platformAdmin/mojo.ts › setPrices: Stripe and the catalog together),
 * never through [MojoControls.save] alone. A key an operator never set keeps the built-in value, so perks.ts stays the
 * reference. Every read is one in-memory row lookup.
 */
export const PLAN_LIMIT_KEYS = ["messageChars", "uploadBytes", "sparks", "customItems", "bots"] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
export const LEVEL_LIMIT_KEYS = ["sparks", "emojiSlots", "stickerSlots", "uploadBytes", "voiceKbps"] as const;
export type LevelLimitKey = (typeof LEVEL_LIMIT_KEYS)[number];

export type PlanOverride = Partial<Record<PlanLimitKey | "listPriceMinor", number>> & { screen?: ScreenPresetId };
export type PlanOverrides = Partial<Record<PlanKey, PlanOverride>>;
export type LevelOverrides = Partial<Record<"1" | "2" | "3", Partial<Record<LevelLimitKey, number>>>>;

/** Hard bounds on what the console may set, whatever the plan (the server's own limits still apply on top). */
export const LIMIT_BOUNDS: Readonly<Record<PlanLimitKey | LevelLimitKey, { min: number; max: number }>> = {
  messageChars: { min: 100, max: 20_000 },
  uploadBytes: { min: 1_000_000, max: GB },
  sparks: { min: 0, max: 100 },
  customItems: { min: 0, max: 5_000 },
  bots: { min: 0, max: 100 },
  emojiSlots: { min: 0, max: 5_000 },
  stickerSlots: { min: 0, max: 5_000 },
  voiceKbps: { min: 16, max: 510 },
};

interface ControlsRow {
  enforce: MojoEnforce | null;
  plans: string;
  levels: string;
  updated_by: string;
  updated_at: number;
}

export interface MojoControlsState {
  /** The console's enforcement choice (null: the environment's MOJO_ENFORCE decides). */
  enforce: MojoEnforce | null;
  plans: PlanOverrides;
  levels: LevelOverrides;
  updatedBy: string | null;
  updatedAt: number | null;
}

const parse = <T>(text: string | undefined): T => {
  try {
    const v = JSON.parse(text ?? "{}") as unknown;
    return (v && typeof v === "object" ? v : {}) as T;
  } catch {
    return {} as T;
  }
};

/** The plans with [o] applied over perks.ts. */
export function plansWith(o: PlanOverrides): Record<PlanKey, PlanPerks> {
  return Object.fromEntries(
    PLAN_KEYS.map((k) => {
      const { screen, ...numbers } = o[k] ?? {};
      return [k, { ...PLAN_PERKS[k], ...numbers, listPriceMinor: k === "plus" ? PLAN_PERKS.plus.listPriceMinor : k === "free" ? 0 : (numbers.listPriceMinor ?? PLAN_PERKS[k].listPriceMinor), uploadBytes: Math.min(numbers.uploadBytes ?? PLAN_PERKS[k].uploadBytes, GB), ...(screen ? { screen: [screen] } : {}) }];
    }),
  ) as Record<PlanKey, PlanPerks>;
}

/** Bounds on a plan's list price, in US cents a month (Stripe's smallest USD charge is 50 cents). */
export const PRICE_BOUNDS = { min: 50, max: 99_99 } as const;

const isScreenPreset = (id: unknown): id is ScreenPresetId => typeof id === "string" && Object.hasOwn(SCREEN_PRESETS, id);
/** A preset's size for comparing plans: pixels × frames. */
const presetWeight = (id: ScreenPresetId) => SCREEN_PRESETS[id].width * SCREEN_PRESETS[id].height * SCREEN_PRESETS[id].fps;
const COMPARED = ["messageChars", "uploadBytes", "customItems", "bots", "sparks"] as const;

/** The Spark levels with [o] applied over perks.ts (level 0 never changes: it's a server without Sparks). */
export function levelsWith(o: LevelOverrides): SparkLevel[] {
  return SPARK_LEVELS.map((l) => (l.level === 0 ? l : { ...l, ...(o[String(l.level) as "1" | "2" | "3"] ?? {}), uploadBytes: Math.min(o[String(l.level) as "1" | "2" | "3"]?.uploadBytes ?? l.uploadBytes!, GB) }));
}

/**
 * Refuses overrides out of bounds, a higher plan with less of anything than a lower one (Free ≤ Go ≤ Plus), a free
 * plan with a price, or levels whose thresholds don't rise (1 < 2 < 3, each at least 1 Spark).
 */
export function checkOverrides(plans: PlanOverrides, levels: LevelOverrides): void {
  const bound = (key: PlanLimitKey | LevelLimitKey, v: number, where: string) => {
    const b = LIMIT_BOUNDS[key];
    if (!b) throw new ApiError(400, "invalid_policy", `${where}: ${key} can't be changed here`);
    if (!Number.isInteger(v) || v < b.min || v > b.max) throw new ApiError(400, "invalid_policy", `${where}: ${key} must be a whole number from ${b.min} to ${b.max}`);
  };
  for (const [plan, values] of Object.entries(plans)) {
    for (const [k, v] of Object.entries(values ?? {})) {
      if (k === "screen") {
        if (!isScreenPreset(v)) throw new ApiError(400, "invalid_policy", `${plan}: screen must be one of ${Object.keys(SCREEN_PRESETS).join(", ")}`);
      } else if (k === "listPriceMinor") {
        const cents = v as number;
        if (plan === "free" ? cents !== 0 : !Number.isInteger(cents) || cents < PRICE_BOUNDS.min || cents > PRICE_BOUNDS.max) {
          throw new ApiError(400, "invalid_policy", plan === "free" ? "Free costs nothing" : `${plan}: the price must be from ${PRICE_BOUNDS.min} to ${PRICE_BOUNDS.max} cents`);
        }
      } else bound(k as PlanLimitKey, v as number, plan);
    }
  }
  const effective = plansWith(plans);
  for (const [lower, higher] of [["free", "go"], ["go", "plus"]] as const) {
    const lo = effective[lower];
    const hi = effective[higher];
    for (const key of COMPARED) {
      if (hi[key] < lo[key]) throw new ApiError(400, "invalid_policy", `${hi.name} can't have less ${key} than ${lo.name} (${hi[key]} < ${lo[key]})`);
    }
    if (presetWeight(hi.screen.at(-1)!) < presetWeight(lo.screen.at(-1)!)) throw new ApiError(400, "invalid_policy", `${hi.name} can't have a smaller screen share than ${lo.name}`);
    if (lower !== "free" && hi.listPriceMinor <= lo.listPriceMinor) throw new ApiError(400, "invalid_policy", `${hi.name} must cost more than ${lo.name}`);
  }
  for (const [level, values] of Object.entries(levels)) for (const [k, v] of Object.entries(values ?? {})) bound(k as LevelLimitKey, v, `Level ${level}`);
  const thresholds = levelsWith(levels).slice(1).map((l) => l.sparks);
  if (thresholds[0]! < 1 || thresholds.some((n, i) => i > 0 && n <= thresholds[i - 1]!)) {
    throw new ApiError(400, "invalid_policy", "Spark levels need rising thresholds: Level 1 at least 1 Spark, then more for Level 2, more again for Level 3");
  }
}

export class MojoControls {
  constructor(private readonly rows: Rows) {}

  state(): MojoControlsState {
    const row = this.rows.get<ControlsRow>("mojo_controls", { id: 1 });
    if (!row) return { enforce: null, plans: {}, levels: {}, updatedBy: null, updatedAt: null };
    return { enforce: row.enforce, plans: parse<PlanOverrides>(row.plans), levels: parse<LevelOverrides>(row.levels), updatedBy: row.updated_by, updatedAt: row.updated_at };
  }

  plans(): Record<PlanKey, PlanPerks> {
    return plansWith(this.state().plans);
  }

  levels(): SparkLevel[] {
    return levelsWith(this.state().levels);
  }

  enforce(): MojoEnforce | null {
    return this.state().enforce;
  }

  /** The catalog's version: perks.ts's, plus when operators last changed a number (clients refresh on a change). */
  version(): string {
    const at = this.state().updatedAt;
    return at ? `${CATALOG_VERSION}+${at}` : CATALOG_VERSION;
  }

  /** Saves the console's controls (checked first). Returns the state before, for the audit. */
  async save(next: { enforce: MojoEnforce | null; plans: PlanOverrides; levels: LevelOverrides }, actor: string, t: number): Promise<MojoControlsState> {
    checkOverrides(next.plans, next.levels);
    const before = this.state();
    const row = { id: 1, enforce: next.enforce, plans: JSON.stringify(next.plans), levels: JSON.stringify(next.levels), updated_by: actor, updated_at: t };
    await this.rows.write((w) => w.upsert("mojo_controls", row, "replace"));
    return before;
  }
}
