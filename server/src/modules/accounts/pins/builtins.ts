/**
 * Meldiq's own profile pins (API 0.64.0, docs/PROFILE_PINS.md): each is earned by reaching a milestone, decided by the
 * server from what it already knows. Their images are assets/pins/<id>.webp (scripts/render-pins.mjs), in this order.
 */
export interface MeldiqPin {
  id: string;
  name: string;
  /** How it's earned, as the apps show it. */
  description: string;
}

/** Accounts made before Meldiq's 1.0 (the beta) are its early members. */
export const BETA_ENDS_AT = Date.UTC(2027, 0, 1);
export const YEAR_MS = 365 * 86_400_000;
export const EXPLORER_COMMUNITIES = 5;
export const FOUNDER_MEMBERS = 10;

export const MELDIQ_PINS: readonly MeldiqPin[] = [
  { id: "early-member", name: "Early member", description: "Joined Meldiq during its beta" },
  { id: "one-year", name: "One year", description: "On Meldiq for a year" },
  { id: "explorer", name: "Explorer", description: `A member of ${EXPLORER_COMMUNITIES} or more communities` },
  { id: "founder", name: "Community builder", description: `Owns a community of ${FOUNDER_MEMBERS} or more members` },
  { id: "spark-giver", name: "Spark giver", description: "Gives a Meldiq Spark to a community" },
  { id: "artist", name: "Artist", description: "Made a profile decoration Meldiq approved" },
  { id: "bug-hunter", name: "Bug hunter", description: "Reported a bug Meldiq fixed" },
];

export const MELDIQ_PIN_IDS = new Set(MELDIQ_PINS.map((p) => p.id));
