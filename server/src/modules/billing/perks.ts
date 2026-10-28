/**
 * Meldiq Mojo's plans and Meldiq Spark's server levels (docs/MOJO.md): the one catalog every limit is read from, on the
 * server and (through GET /v2/mojo/catalog) in every client. Prices shown before the plans are on sale are the list
 * prices here; what a checkout charges is always the billing catalog's published version (docs/BILLING.md).
 *
 * Units are decimal, as people read them: 1 MB = 1,000,000 bytes, 1 GB = 1,000,000,000 bytes. "2K" is 2560×1440.
 */
export const CATALOG_VERSION = "2026-10-28.1";

export const PLAN_KEYS = ["free", "go", "plus"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export const isPlanKey = (k: string): k is PlanKey => (PLAN_KEYS as readonly string[]).includes(k);
/** Higher is more: the plan that applies when several do (a subscription and a gift, say). */
export const PLAN_RANK: Readonly<Record<PlanKey, number>> = { free: 0, go: 1, plus: 2 };

/** The billing catalog's key of the Meldiq Spark add-on: bought in any quantity, next to (never instead of) a plan. */
export const SPARK_PLAN_KEY = "spark";
export const isAddonPlanKey = (k: string): boolean => k === SPARK_PLAN_KEY;

export const MB = 1_000_000;
export const GB = 1_000_000_000;

/** A screen share's ceiling: up to this many pixels (width × height of the preset) at up to this frame rate. */
export interface ScreenPreset {
  id: ScreenPresetId;
  label: string;
  width: number;
  height: number;
  fps: number;
}
export const SCREEN_PRESETS = {
  "720p30": { id: "720p30", label: "720p 30 fps", width: 1280, height: 720, fps: 30 },
  "720p60": { id: "720p60", label: "720p 60 fps", width: 1280, height: 720, fps: 60 },
  "1080p30": { id: "1080p30", label: "1080p 30 fps", width: 1920, height: 1080, fps: 30 },
  "1080p60": { id: "1080p60", label: "1080p 60 fps", width: 1920, height: 1080, fps: 60 },
  "1440p30": { id: "1440p30", label: "2K (1440p) 30 fps", width: 2560, height: 1440, fps: 30 },
} as const satisfies Record<string, { id: string; label: string; width: number; height: number; fps: number }>;
export type ScreenPresetId = keyof typeof SCREEN_PRESETS;

export interface PlanPerks {
  key: PlanKey;
  name: string;
  /** The list price per month in US cents (0 for Free); a checkout charges the billing catalog's published price. */
  listPriceMinor: number;
  /** User-perceived characters (grapheme clusters) in one message or edit. */
  messageChars: number;
  /** The largest single file (not a storage quota). */
  uploadBytes: number;
  /** Screen-share ceilings this plan allows (any one of them). */
  screen: readonly ScreenPresetId[];
  /** Meldiq Sparks included while the plan applies. */
  sparks: number;
  /** The name badge it shows (hideable), and whether it adds the Meldiq Check (a perk, never identity verification). */
  badge: "go" | "plus" | null;
  check: boolean;
  /** Custom emoji and stickers this account may have added across communities (one pool). */
  customItems: number;
  /**
   * Bots an account may own, and how its directory submissions are queued. Meldiq has no bots yet (docs/MOJO.md ›
   * Not built): these are the agreed numbers, kept here for when it does; clients don't list them as a benefit.
   */
  bots: number;
  botReview: "regular" | "priority";
}

export const PLAN_PERKS: Readonly<Record<PlanKey, PlanPerks>> = {
  free: {
    key: "free", name: "Free", listPriceMinor: 0, messageChars: 1000, uploadBytes: 50 * MB, screen: ["720p30"], sparks: 0, badge: null, check: false,
    customItems: 20, bots: 2, botReview: "regular",
  },
  go: {
    key: "go", name: "Mojo Go", listPriceMinor: 99, messageChars: 2000, uploadBytes: 200 * MB, screen: ["720p60", "1080p30"], sparks: 1, badge: "go", check: false,
    customItems: 50, bots: 4, botReview: "regular",
  },
  plus: {
    key: "plus", name: "Mojo Plus", listPriceMinor: 399, messageChars: 5000, uploadBytes: 2 * GB, screen: ["1080p60", "1440p30"], sparks: 2, badge: "plus", check: true,
    customItems: 250, bots: 10, botReview: "priority",
  },
};

/** One additional Spark: $0.99 a month each, on any plan (a recurring add-on, like a server boost). */
export const SPARK_LIST_PRICE_MINOR = 99;
export const SPARK_MAX_PURCHASE = 20;

/** A server's shared benefits from its members' Sparks. Level 0 is the server as it is without any. */
export interface SparkLevel {
  level: 0 | 1 | 2 | 3;
  /** Active Sparks needed. */
  sparks: number;
  emojiSlots: number;
  stickerSlots: number;
  /** The largest single file anyone may share in the server (null: the person's own plan only). */
  uploadBytes: number | null;
  /** The voice bitrate ceiling clients publish at in the server's calls. */
  voiceKbps: number;
  /** Screen-share ceilings everyone in the server may use. */
  screen: readonly ScreenPresetId[];
}

export const SPARK_LEVELS: readonly SparkLevel[] = [
  // Level 0 is what servers have today: 50 emoji, 20 stickers, the apps' 48 kbps voice (LiveKit's music preset).
  { level: 0, sparks: 0, emojiSlots: 50, stickerSlots: 20, uploadBytes: null, voiceKbps: 48, screen: [] },
  { level: 1, sparks: 1, emojiSlots: 100, stickerSlots: 20, uploadBytes: 50 * MB, voiceKbps: 128, screen: ["720p30"] },
  { level: 2, sparks: 2, emojiSlots: 200, stickerSlots: 20, uploadBytes: 200 * MB, voiceKbps: 256, screen: ["1080p60"] },
  { level: 3, sparks: 3, emojiSlots: 500, stickerSlots: 20, uploadBytes: 2 * GB, voiceKbps: 384, screen: ["1080p60", "1440p30"] },
];
export const MAX_SPARK_LEVEL = 3;

/** The level [active] Sparks give (capped at 3: more never shows a level 4). */
export function sparkLevel(active: number): SparkLevel {
  return SPARK_LEVELS[Math.max(0, Math.min(MAX_SPARK_LEVEL, Math.floor(active)))]!;
}

/** Gift lengths on offer, in months; a gift's price is the plan's monthly price times its months. */
export const GIFT_MONTHS = [1, 3, 12] as const;
export type GiftMonths = (typeof GIFT_MONTHS)[number];
export const GIFT_NOTE_MAX = 280;

/** Whether one of [presets] covers a share of [width]×[height] at [fps] (the larger side counted as the width). */
export function screenAllows(presets: readonly ScreenPresetId[], width: number, height: number, fps: number | null): boolean {
  const [long, short] = width >= height ? [width, height] : [height, width];
  return presets.some((id) => {
    const p = SCREEN_PRESETS[id];
    return long <= p.width && short <= p.height && (fps === null || fps <= p.fps);
  });
}

/** The presets in [a] and [b] together, without repeats, in catalog order. */
export function unionPresets(a: readonly ScreenPresetId[], b: readonly ScreenPresetId[]): ScreenPresetId[] {
  const set = new Set([...a, ...b]);
  return (Object.keys(SCREEN_PRESETS) as ScreenPresetId[]).filter((id) => set.has(id));
}

/**
 * The largest encrypted message a plan may send, in base64 characters. Messages are end-to-end encrypted: the server
 * can't count characters, so clients count them exactly and the server refuses ciphertext far beyond what the plan's
 * characters could take (12 bytes per character covers emoji sequences and any script, plus room for replies,
 * attachments, mentions and link previews), never above MAX_CIPHERTEXT_B64.
 */
export const MESSAGE_OVERHEAD_BYTES = 24 * 1024;
export const BYTES_PER_CHAR = 12;
export function ciphertextCeilingB64(messageChars: number, hardMax: number): number {
  const plaintext = MESSAGE_OVERHEAD_BYTES + messageChars * BYTES_PER_CHAR;
  return Math.min(hardMax, Math.ceil(((plaintext + 16) * 4) / 3) + 4);
}

/** The whole catalog as clients read it (GET /v2/mojo/catalog). */
export function catalogView() {
  return {
    version: CATALOG_VERSION,
    units: { mb: MB, gb: GB },
    plans: PLAN_KEYS.map((k) => PLAN_PERKS[k]),
    screenPresets: Object.values(SCREEN_PRESETS),
    spark: { listPriceMinor: SPARK_LIST_PRICE_MINOR, interval: "month" as const, maxPurchase: SPARK_MAX_PURCHASE, levels: SPARK_LEVELS },
    gifts: { months: GIFT_MONTHS, noteMax: GIFT_NOTE_MAX },
  };
}
