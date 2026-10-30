import { BOT_LIMITS } from "../../shared/contracts/http/officialBots.js";

/** "!giveaway <duration> [Nw] <prize>": how long it runs, how many win and what. */
export interface GiveawayRequest {
  durationMs: number;
  winners: number;
  prize: string;
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
const DAY_MS = UNIT_MS.d!;
/** The shortest giveaway: anything shorter ends before anyone could react. */
export const MIN_GIVEAWAY_MS = 10_000;
const DURATION = /^(?:\d{1,4}[smhdw])+$/i;
const WINNERS = /^(\d{1,3})w$/i;

export const GIVEAWAY_USAGE = "Start one with !giveaway 1d Prize, or !giveaway 2h 3w Prize for three winners (s, m, h, d or w).";

/** "1d", "2h30m", "45s": milliseconds, or null when it doesn't read as a duration. */
export function parseDuration(token: string): number | null {
  if (!DURATION.test(token)) return null;
  let total = 0;
  for (const m of token.toLowerCase().matchAll(/(\d+)([smhdw])/g)) total += Number(m[1]) * UNIT_MS[m[2]!]!;
  return total;
}

/**
 * Reads a giveaway command against the community's limits (free: 7 days and 3 winners; Bots+: 30 days and 20).
 * Returns the request, or the line to answer with when something's off.
 */
export function parseGiveaway(args: string, plus: boolean): { ok: GiveawayRequest } | { error: string } {
  const tokens = args.split(/\s+/).filter(Boolean);
  const durationMs = tokens[0] ? parseDuration(tokens[0]) : null;
  if (durationMs === null) return { error: `🎉 ${GIVEAWAY_USAGE}` };
  const winnerToken = tokens[1] ? WINNERS.exec(tokens[1]) : null;
  const winners = winnerToken ? Number(winnerToken[1]) : 1;
  const prize = tokens.slice(winnerToken ? 2 : 1).join(" ").trim();
  if (!prize) return { error: `🎉 What's the prize? ${GIVEAWAY_USAGE}` };
  if ([...prize].length > BOT_LIMITS.giveawayPrize) return { error: `🎉 Keep the prize under ${BOT_LIMITS.giveawayPrize} characters.` };
  const days = plus ? BOT_LIMITS.giveawayDays.plus : BOT_LIMITS.giveawayDays.free;
  if (durationMs < MIN_GIVEAWAY_MS) return { error: "🎉 Give people at least 10 seconds to enter." };
  if (durationMs > days * DAY_MS) {
    return { error: `🎉 A giveaway here can run for up to ${days} days${plus ? "" : ` (${BOT_LIMITS.giveawayDays.plus} with Bots+)`}.` };
  }
  const most = plus ? BOT_LIMITS.giveawayWinners.plus : BOT_LIMITS.giveawayWinners.free;
  if (winners < 1 || winners > most) {
    return { error: `🎉 A giveaway here can have 1 to ${most} winners${plus ? "" : ` (${BOT_LIMITS.giveawayWinners.plus} with Bots+)`}.` };
  }
  return { ok: { durationMs, winners, prize } };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "in 2 hours (31 Oct, 14:00 UTC)": when a giveaway ends, seen from [now]. */
export function endsText(endsAt: number, now: number): string {
  const s = Math.max(0, Math.round((endsAt - now) / 1000));
  const rel = s < 60 ? plural(s, "second") : s < 3600 ? plural(Math.round(s / 60), "minute") : s < 86_400 ? plural(Math.round(s / 3600), "hour") : plural(Math.round(s / 86_400), "day");
  const d = new Date(endsAt);
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const time = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `in ${rel} (${d.getUTCDate()} ${month}, ${time} UTC)`;
}

/** [n] different people of [pool], drawn at random with [randomInt] (crypto's by default). */
export function draw<T>(pool: readonly T[], n: number, randomInt: (max: number) => number): T[] {
  const xs = [...pool];
  for (let i = xs.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs.slice(0, n);
}
