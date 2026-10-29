import crypto from "node:crypto";
import type { Command } from "./commands.js";
import type { MessagePosted } from "./events.js";
import type { ActiveBot, OfficialBots } from "./runtime.js";
import type { AfkRow } from "./store.js";

/** Helper's own commands (besides !help, which commands.ts answers for every bot). */
export const HELPER_COMMANDS: readonly string[] = ["8ball", "roll", "flip", "choose", "afk"];

const DICE = { maxCount: 20, minSides: 2, maxSides: 1000, defaultSides: 6 } as const;
const CHOICES = { min: 2, max: 20, length: 100 } as const;
const AFK_REASON_MAX = 200;
/** People told about one away note at most (then everyone mentioning them is told again). */
const AFK_NOTIFIED_MAX = 50;

/** The fortune ball's answers: Meldiq's own. */
const FORTUNES = [
  "Looks likely to me.",
  "Yes, no doubt about it.",
  "Go for it.",
  "The signs say yes.",
  "Ask again after a snack.",
  "Hard to tell right now. Try later.",
  "I'd sleep on it.",
  "Even I can't see that one.",
  "Not a chance.",
  "My answer is no.",
  "I wouldn't count on it.",
  "Doubtful, honestly.",
];

const pick = <T>(xs: readonly T[]): T => xs[crypto.randomInt(0, xs.length)]!;

/** "5 minutes ago", "3 hours ago", "2 days ago". */
export function ago(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "!roll", "!roll 20", "!roll 2d6": the dice and their sides, or null when it doesn't read as dice. */
export function parseDice(args: string): { count: number; sides: number } | null {
  if (!args) return { count: 1, sides: DICE.defaultSides };
  const m = /^(\d{1,3})?d(\d{1,5})$/i.exec(args.replace(/\s+/g, "")) ?? (/^(\d{1,5})$/.exec(args) ? [args, "1", args] : null);
  if (!m) return null;
  const count = Number(m[1] ?? 1);
  const sides = Number(m[2]);
  if (count < 1 || count > DICE.maxCount || sides < DICE.minSides || sides > DICE.maxSides) return null;
  return { count, sides };
}

function roll(who: string, args: string): string {
  const dice = parseDice(args);
  if (!dice) return `🎲 Try !roll, !roll 20 or !roll 2d6 (up to ${DICE.maxCount} dice with up to ${DICE.maxSides} sides).`;
  const rolls = Array.from({ length: dice.count }, () => crypto.randomInt(1, dice.sides + 1));
  if (rolls.length === 1) return `🎲 ${who} rolled a d${dice.sides}: ${rolls[0]}`;
  return `🎲 ${who} rolled ${dice.count}d${dice.sides}: ${rolls.join(" + ")} = ${rolls.reduce((a, b) => a + b, 0)}`;
}

function choose(args: string): string {
  const options = args.split("|").map((o) => o.trim()).filter(Boolean);
  if (options.length < CHOICES.min || options.length > CHOICES.max || options.some((o) => o.length > CHOICES.length)) {
    return "🤔 Give me at least two things to pick from, like !choose pizza | tacos | sushi";
  }
  return `🤔 I pick: ${pick(options)}`;
}

async function setAway(rt: OfficialBots, bot: ActiveBot, ev: MessagePosted, who: string, args: string): Promise<string> {
  const reason = (args || "Away for now").slice(0, AFK_REASON_MAX);
  await rt.ctx.ws.write((w) => w.upsert("bot_afk", { org_id: bot.orgId, user_id: ev.userId, reason, since: ev.at, notified: "[]" }, "replace"));
  return `💤 ${who} is away: ${reason}. I'll tell anyone who mentions you, and your next message here brings you back.`;
}

/** Helper's built-in commands. */
export async function runHelperCommand(rt: OfficialBots, bot: ActiveBot<"helper">, ev: MessagePosted, cmd: Command): Promise<void> {
  const who = rt.nameOf(ev.userId);
  const reply = await (async () => {
    switch (cmd.name) {
      case "8ball":
        return cmd.args ? `🎱 ${pick(FORTUNES)}` : "🎱 Ask me a yes-or-no question after !8ball.";
      case "roll":
        return roll(who, cmd.args);
      case "flip":
        return `🪙 ${who} flipped a coin: ${crypto.randomInt(0, 2) === 0 ? "heads" : "tails"}.`;
      case "choose":
        return choose(cmd.args);
      case "afk":
        return setAway(rt, bot, ev, who, cmd.args);
      default:
        return null;
    }
  })();
  if (reply) await rt.chat(bot, ev.conversationId, reply);
}

/** A community's own command (Bots+): its response, with {user} as a mention of whoever ran it. */
export async function runCustomCommand(rt: OfficialBots, bot: ActiveBot<"helper">, ev: MessagePosted, response: string): Promise<void> {
  const username = rt.people([ev.userId]).get(ev.userId)?.username;
  const mentions = response.includes("{user}") && username ? [ev.userId] : [];
  await rt.chat(bot, ev.conversationId, response.replaceAll("{user}", username ? `@${username}` : rt.nameOf(ev.userId)), mentions);
}

/**
 * Away notes on every message: the sender's own note ends with their next message (not the !afk that set it), and
 * whoever mentions someone who is away is told why, once per note.
 */
export async function noteAway(rt: OfficialBots, bot: ActiveBot<"helper">, ev: MessagePosted, settingAway: boolean): Promise<void> {
  const { ws } = rt.ctx;
  if (!settingAway && ws.get("bot_afk", { org_id: bot.orgId, user_id: ev.userId })) {
    await ws.write((w) => w.delete("bot_afk", { org_id: bot.orgId, user_id: ev.userId }));
    await rt.chat(bot, ev.conversationId, `👋 Welcome back, ${rt.nameOf(ev.userId)}. Your away note is gone.`);
  }
  const mentioned = Array.isArray(ev.payload.mentions) ? ev.payload.mentions.filter((m): m is string => typeof m === "string" && m !== ev.userId) : [];
  if (mentioned.length === 0) return;
  const away = ws.all<AfkRow>("bot_afk", { where: { org_id: bot.orgId, user_id: { in: [...new Set(mentioned)] } } }).filter((r) => !(JSON.parse(r.notified) as string[]).includes(ev.userId));
  if (away.length === 0) return;
  await ws.write((w) => {
    for (const r of away) {
      const told = [...(JSON.parse(r.notified) as string[]), ev.userId].slice(-AFK_NOTIFIED_MAX);
      w.update("bot_afk", { org_id: r.org_id, user_id: r.user_id }, { notified: JSON.stringify(told) });
    }
  });
  const people = rt.people(away.map((r) => r.user_id));
  const lines = away.map((r) => `💤 ${people.get(r.user_id)?.displayName ?? "They"} is away: ${r.reason} (${ago(ev.at - r.since)})`);
  await rt.chat(bot, ev.conversationId, lines.join("\n"));
}
